// 字数统计·打回编剧重申工作台：静态页面 + 登录 + POST /api/analyze（零依赖）
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Pool } = require('./lib/pool');
const { createAuth, Throttle } = require('./lib/auth');
const fmt = require('./lib/format');
const { createTranslationManager } = require('./lib/translate');
const { summarizeBooks } = require('./public/audit-summary');
const { exportAuditXlsx } = require('./lib/audit-export');
const { writeAll: writeZip } = require('./lib/format/zip');

const PORT = process.env.PORT === '0' ? 0 : Number(process.env.PORT) || 3000; // PORT=0：随机空闲端口（测试用）
const HOST = process.env.HOST || '127.0.0.1';
const MAX_FILE = 30 * 1024 * 1024; // 单文件上限
const MAX_BATCH_BOOKS = 100;
const MAX_BATCH_BODY = 128 * 1024 * 1024; // 100 本段落数组的批量修复/导出请求
const MAX_QUEUE = 64; // 排队中的解析任务上限，超出返回 503
const MAX_PER_IP = 24; // 单 IP 同时在途请求
const TRUST_PROXY = process.env.TRUST_PROXY === '1'; // 在 nginx 后面时设为 1，按 X-Forwarded-For 区分访客
const COOKIE = 'cd_session';
const DAY = 24 * 3600;

// AUTH=用户名:密码，不设置则免登录。BASIC_AUTH 是旧版变量名，仍然识别
let auth;
try {
  auth = createAuth({ credentials: process.env.AUTH || process.env.BASIC_AUTH || '', secret: process.env.SESSION_SECRET || '' });
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
// 监听公网地址却没设登录 = 任何人都能用，直接拒绝启动
if (!auth.enabled && !/^(127\.|localhost$|::1$)/.test(HOST)) {
  console.error(`监听 ${HOST} 时必须设置 AUTH=用户名:密码`);
  process.exit(1);
}

const pool = new Pool(Math.max(2, Math.min(os.cpus().length, 8)));
const throttle = new Throttle(); // 登录失败限流：同一来源 15 分钟内最多失败 5 次
const inflight = new Map();
const translations = createTranslationManager();

const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const statics = new Map();
for (const f of fs.readdirSync(PUBLIC)) statics.set('/' + f, f);
statics.set('/', 'type.html');
// 统一把现有批量字数统计页挂在 /type，根路径保留为兼容入口；后续 type 页面可继续按同一命名扩展。
statics.set('/type', 'type.html');
statics.set('/login', 'login.html');
// 正文翻译是独立页面，不复用 /type 的页面状态或脚本；保留两个入口便于书签和旧链接。
statics.set('/type-translate', 'type-translate.html');
statics.set('/translate', 'type-translate.html');
statics.delete('/login.html');
statics.delete('/type.html');
statics.delete('/index.html');
statics.delete('/app.js');
const OPEN = new Set(['/login', '/login.css', '/login.js', '/style.css']); // 登录前就要能打开的

const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, ...SECURITY, ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function redirect(res, to) {
  res.writeHead(302, { Location: to, 'Cache-Control': 'no-store', ...SECURITY });
  res.end();
}

function serveStatic(res, url) {
  const file = statics.get(url);
  fs.readFile(path.join(PUBLIC, file), (err, data) => {
    if (err) return send(res, 500, 'read error', 'text/plain');
    const ext = path.extname(file);
    // 页面不缓存（也不进后退缓存），退出登录后按「后退」看不到旧页面
    send(res, 200, data, TYPES[ext] || 'application/octet-stream', { 'Cache-Control': ext === '.html' ? 'no-store' : 'no-cache' });
  });
}

const clientIp = (req) => (TRUST_PROXY && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress;
const isHttps = (req) => Boolean(req.socket.encrypted) || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');

function getCookie(req, name) {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(req.headers.cookie || '');
  return m ? m[1] : '';
}

const authed = (req) => !auth.enabled || auth.verify(getCookie(req, COOKIE)) !== null;

function sessionCookie(req, value, maxAge) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax` + (maxAge === undefined ? '' : `; Max-Age=${maxAge}`) + (isHttps(req) ? '; Secure' : '');
}

function readBody(req, limit, tooBigMsg) {
  return new Promise((resolve, reject) => {
    const tooBig = () => Object.assign(new Error(tooBigMsg), { status: 413 });
    if (Number(req.headers['content-length']) > limit) return reject(tooBig());
    const chunks = [];
    let size = 0;
    const onData = (c) => {
      size += c.length;
      if (size > limit) { req.off('data', onData); chunks.length = 0; reject(tooBig()); }
      else chunks.push(c);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleLogin(req, res) {
  const ip = clientIp(req);
  const wait = throttle.wait(ip);
  if (wait) {
    const left = wait > 90 ? `${Math.ceil(wait / 60)} 分钟` : `${wait} 秒`;
    return send(res, 429, { error: `尝试次数过多，请 ${left}后再试` }, undefined, { 'Retry-After': String(wait) });
  }

  let body;
  try {
    body = JSON.parse((await readBody(req, 4096, '请求体过大')).toString() || 'null');
  } catch (e) {
    return send(res, e.status || 400, { error: e.status ? e.message : '请求格式错误' });
  }

  if (!body || typeof body !== 'object' || !auth.check(body.username, body.password)) {
    throttle.fail(ip);
    await new Promise((r) => setTimeout(r, 400)); // 拖慢暴力尝试
    return send(res, 401, { error: '账号或密码错误' });
  }

  throttle.ok(ip);
  const remember = body.remember === true; // 勾了「30 天内免登录」才发持久 Cookie，否则关浏览器即失效
  send(res, 200, { ok: true }, undefined, {
    'Cache-Control': 'no-store',
    'Set-Cookie': sessionCookie(req, auth.sign(remember ? 30 * DAY : DAY / 2), remember ? 30 * DAY : undefined),
  });
}

function handleLogout(req, res) {
  send(res, 200, { ok: true }, undefined, { 'Cache-Control': 'no-store', 'Set-Cookie': sessionCookie(req, '', 0) });
}

const TRANSLATION_REQUEST_MAX = 24 * 1024 * 1024;

function translationStatus(job) {
  return {
    jobId: job.id,
    name: job.name,
    status: job.status,
    total: job.episodes.length,
    completed: job.completed,
    failed: job.failed,
    queued: job.queued,
    running: job.running,
    currentEpisode: job.currentEpisode,
    targetLanguage: job.targetLanguage,
    modelKey: job.model.key,
    // SSE 不可用时页面会轮询；把已完成的逐集结果一并带回，保持同一套预览/导出合同。
    results: [...job.translations.entries()].map(([episode, translation]) => ({ episode, translation })),
    episodeStatuses: [...job.episodeStatuses.entries()].map(([episode, status]) => ({ episode, status })),
    error: job.error,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  };
}

async function handleTranslationStart(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req, TRANSLATION_REQUEST_MAX, '翻译请求超过 24MB')).toString() || 'null');
  } catch (e) {
    return send(res, e.status || 400, { error: e.status ? e.message : '请求格式错误' });
  }
  try {
    translations.preflight(body);
    const created = translations.start(body);
    return send(res, 202, created, undefined, { 'Cache-Control': 'no-store' });
  } catch (e) {
    return send(res, e.status || 400, { error: e.message || '翻译任务创建失败', code: e.code || 'translation_start_failed' });
  }
}

function handleTranslationStatus(req, res, jobId) {
  const job = translations.get(jobId);
  if (!job) return send(res, 404, { error: '找不到翻译任务', code: 'translation_job_not_found' });
  return send(res, 200, translationStatus(job), undefined, { 'Cache-Control': 'no-store' });
}

function writeTranslationEvent(res, event) {
  if (!event) {
    if (!res.writableEnded) res.end();
    return;
  }
  if (res.writableEnded) return;
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function handleTranslationEvents(req, res, jobId) {
  const job = translations.get(jobId);
  if (!job) return send(res, 404, { error: '找不到翻译任务', code: 'translation_job_not_found' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store',
    Connection: 'keep-alive',
    ...SECURITY,
  });
  res.flushHeaders?.();
  res.write(': connected\n\n');
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': keepalive\n\n');
  }, 15000);
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    translations.unsubscribe(jobId, listener);
    if (!res.writableEnded) res.end();
  };
  const listener = (event) => {
    if (event) writeTranslationEvent(res, event);
    else finish();
  };
  translations.subscribe(jobId, listener);
  req.on('close', finish);
}

function handleTranslationModels(req, res) {
  return send(res, 200, translations.availability(), undefined, { 'Cache-Control': 'no-store' });
}

function handleTranslationCancel(req, res, jobId) {
  try {
    const job = translations.cancel(jobId);
    return send(res, 200, translationStatus(job), undefined, { 'Cache-Control': 'no-store' });
  } catch (e) {
    return send(res, e.status || 500, { error: e.message || '停止失败', code: e.code || 'translation_cancel_failed' });
  }
}

// 页面带着已完成的译文来导出：不依赖服务器任务，重启/过期/分批重试后依然能导出整本
async function handleTranslationExportStateless(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req, TRANSLATION_REQUEST_MAX, '导出请求超过 24MB')).toString() || 'null');
  } catch (e) {
    return send(res, e.status || 400, { error: e.status ? e.message : '请求格式错误' });
  }
  try {
    const out = translations.exportFromPayload(body);
    const filename = encodeURIComponent(`${out.name || '剧本'}_${out.targetLanguage}_翻译.docx`);
    return send(res, 200, out.buffer,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      {
        'Content-Disposition': `attachment; filename*=UTF-8''${filename}`, 'Cache-Control': 'no-store',
        'X-Missing-Episodes': out.missingEpisodes.join(','),
      });
  } catch (e) {
    return send(res, e.status || 500, { error: e.message || '翻译导出失败', code: e.code || 'translation_export_failed' });
  }
}

async function handleTranslationExport(req, res, jobId) {
  try {
    let mode = 'replace';
    if (req.method === 'POST') {
      const raw = await readBody(req, 4096, '导出参数过大');
      if (raw.length) {
        let body;
        try { body = JSON.parse(raw.toString() || '{}'); } catch { return send(res, 400, { error: '导出参数格式错误', code: 'translation_export_options_invalid' }); }
        if (body && body.mode !== undefined && body.mode !== 'replace' && body.mode !== 'bilingual') {
          return send(res, 400, { error: '导出方式只支持 replace 或 bilingual', code: 'translation_export_options_invalid' });
        }
        mode = body?.mode || mode;
      }
    }
    const job = translations.get(jobId);
    if (!job) return send(res, 404, { error: '找不到翻译任务', code: 'translation_job_not_found' });
    const out = translations.export(jobId, { mode });
    const filename = encodeURIComponent(`${job.name || '剧本'}_${job.targetLanguage}_翻译.docx`);
    return send(res, 200, out.buffer,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      { 'Content-Disposition': `attachment; filename*=UTF-8''${filename}`, 'Cache-Control': 'no-store' });
  } catch (e) {
    return send(res, e.status || 500, {
      error: e.message || '翻译导出失败',
      code: e.code || 'translation_export_failed',
      ...(Array.isArray(e.missingEpisodes) ? { missingEpisodes: e.missingEpisodes } : {}),
    });
  }
}

// 校验链路：upload（文件 → 校验 → 通过才统计）、recheck / fix / export（JSON 段落数组，用于页面内修改后重验）
async function handleFormat(req, res, kind) {
  const ip = clientIp(req);
  if ((inflight.get(ip) || 0) >= MAX_PER_IP || pool.pending >= MAX_QUEUE) {
    return send(res, 503, { error: '服务繁忙，请稍后重试' }, undefined, { 'Retry-After': '3' });
  }
  inflight.set(ip, (inflight.get(ip) || 0) + 1);
  try {
    if (kind === 'validate') {
      let name = '';
      try { name = decodeURIComponent(req.headers['x-filename'] || ''); } catch { /* 留空 */ }
      if (!name) return send(res, 400, { error: '缺少文件名' });
      const buf = await readBody(req, MAX_FILE, '文件超过 30MB');
      if (!buf.length) return send(res, 400, { error: '文件内容为空' });
      return send(res, 200, await pool.run(buf, name, 'validate'));
    }
    let body;
    try { body = JSON.parse((await readBody(req, MAX_FILE, '请求体过大')).toString() || 'null'); } catch (e) {
      return send(res, e.status || 400, { error: e.status ? e.message : '请求格式错误' });
    }
    if (!body || !Array.isArray(body.paragraphs) || body.paragraphs.some((x) => typeof x !== 'string') || body.paragraphs.length > 200000) {
      return send(res, 400, { error: '缺少 paragraphs（字符串数组）' });
    }
    const name = String(body.name || '').slice(0, 200);
    if (kind === 'count') return send(res, 200, fmt.countSelection(body.paragraphs, body.lang === 'en' ? 'en' : 'zh'));
    if (kind === 'recheck') return send(res, 200, fmt.validateParagraphs(body.paragraphs, name));
    if (kind === 'fix') return send(res, 200, fmt.fixParagraphs(body.paragraphs, name));
    if (kind === 'fix-cast-notes') return send(res, 200, fmt.fixCastNotes(body.paragraphs, name));
    // export：只有通过校验的稿件才能导出标准 docx
    const report = fmt.check(body.paragraphs);
    if (!report.ok) return send(res, 422, { error: '格式校验未通过，不能导出', errors: report.errors });
    const file = encodeURIComponent(`${name || '剧本'}_标准格式.docx`);
    return send(res, 200, fmt.exportDocx(body.paragraphs), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', { 'Content-Disposition': `attachment; filename*=UTF-8''${file}` });
  } catch (e) {
    const status = e.status || 400;
    if (status === 413) res.once('finish', () => req.destroy());
    send(res, status, { error: e.message || '处理失败' }, undefined, status === 413 ? { Connection: 'close' } : {});
  } finally {
    const n = (inflight.get(ip) || 1) - 1;
    n ? inflight.set(ip, n) : inflight.delete(ip);
  }
}

async function handleAuditExport(req, res) {
  try {
    const raw = await readBody(req, 8 * 1024 * 1024, '统计数据超过8MB，请减少集数后重试');
    let body;
    try { body = JSON.parse(raw.toString()); } catch { return send(res, 400, { error: '导出参数格式错误' }); }
    if (!body || typeof body !== 'object' || !Array.isArray(body.books) || !body.books.length) {
      return send(res, 400, { error: '请先导入需要审核的剧本' });
    }
    const summary = summarizeBooks(body.books, body.options);
    const output = exportAuditXlsx(summary);
    const filename = `剧本审核统计_${new Date().toISOString().slice(0, 10)}.xlsx`;
    return send(res, 200, output, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', {
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control': 'no-store',
    });
  } catch (error) {
    return send(res, error.status || 400, { error: error.message || '导出Excel失败' });
  }
}

function readBatchBooks(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.books) || !body.books.length) {
    throw Object.assign(new Error('请先导入需要处理的剧本'), { status: 400 });
  }
  if (body.books.length > MAX_BATCH_BOOKS) {
    throw Object.assign(new Error(`每批最多处理${MAX_BATCH_BOOKS}本剧本`), { status: 400 });
  }
  return body.books.map((book, index) => {
    if (!book || typeof book !== 'object' || !Array.isArray(book.paragraphs) || book.paragraphs.some((x) => typeof x !== 'string') || book.paragraphs.length > 200000) {
      throw Object.assign(new Error(`第${index + 1}本缺少有效 paragraphs（字符串数组）`), { status: 400 });
    }
    const name = String(book.name || `剧本${index + 1}`).slice(0, 200);
    return { id: book.id == null ? index + 1 : book.id, name, paragraphs: book.paragraphs };
  });
}

async function readBatchBody(req) {
  let raw;
  try { raw = await readBody(req, MAX_BATCH_BODY, '批量请求超过 128MB'); } catch (e) { throw e; }
  try { return JSON.parse(raw.toString() || 'null'); } catch { throw Object.assign(new Error('批量请求格式错误'), { status: 400 }); }
}

async function handleBatchFix(req, res) {
  try {
    const books = readBatchBooks(await readBatchBody(req));
    const result = books.map((book) => {
      const before = fmt.check(book.paragraphs);
      const fixed = fmt.autoFixAngleTags(book.paragraphs);
      const validated = fmt.validateParagraphs(fixed.paras, book.name);
      return { id: book.id, name: book.name, paragraphs: validated.paragraphs, applied: fixed.applied, angleRemoved: before.issues.filter((x) => x.code === 'model-output-angle-tag').length, format: validated.format, analysis: validated.analysis, marks: validated.marks };
    });
    return send(res, 200, { books: result, total: result.length, changed: result.filter((x) => x.applied > 0).length, applied: result.reduce((n, x) => n + x.applied, 0) }, undefined, { 'Cache-Control': 'no-store' });
  } catch (e) {
    return send(res, e.status || 400, { error: e.message || '批量修复失败' });
  }
}

function safeZipName(name, used) {
  const base = String(name || '剧本').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || '剧本';
  let candidate = `${base}_标准格式.docx`;
  let n = 2;
  while (used.has(candidate)) candidate = `${base}_${n++}_标准格式.docx`;
  used.add(candidate);
  return candidate;
}

async function handleBatchExport(req, res) {
  try {
    const books = readBatchBooks(await readBatchBody(req));
    const invalid = [];
    const files = new Map(); const used = new Set();
    for (const book of books) {
      const report = fmt.check(book.paragraphs);
      if (!report.ok) { invalid.push({ id: book.id, name: book.name, errors: report.errors }); continue; }
      files.set(safeZipName(book.name, used), fmt.exportDocx(book.paragraphs));
    }
    if (invalid.length) return send(res, 422, { error: `仍有 ${invalid.length} 本格式未通过，未生成压缩包`, invalid });
    const output = writeZip(files);
    const filename = `修复后剧本_${new Date().toISOString().slice(0, 10)}.zip`;
    return send(res, 200, output, 'application/zip', { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`, 'Cache-Control': 'no-store' });
  } catch (e) {
    return send(res, e.status || 400, { error: e.message || '批量导出失败' });
  }
}

function handle(req, res) {
  const url = req.url.split('?')[0];
  const get = req.method === 'GET';

  if (req.method === 'POST' && url === '/api/login') return handleLogin(req, res);
  if (req.method === 'POST' && url === '/api/logout') return handleLogout(req, res);

  if (get && url === '/login' && authed(req)) return redirect(res, '/type'); // 已登录就不用再看登录页
  if (get && OPEN.has(url)) return serveStatic(res, url);

  if (!authed(req)) {
    // 页面跳登录页；接口和其他资源直接 401
    return get && (url === '/' || url === '/type' || url === '/type-translate' || url === '/translate')
      ? redirect(res, '/login') : send(res, 401, { error: '未登录' });
  }

  if (req.method === 'POST' && url === '/api/audit/export') return handleAuditExport(req, res);
  if (req.method === 'POST' && url === '/api/fix-batch') return handleBatchFix(req, res);
  if (req.method === 'POST' && url === '/api/export-batch') return handleBatchExport(req, res);

  if (req.method === 'POST' && url === '/api/translate/start') return handleTranslationStart(req, res);
  if (get && url === '/api/translate/models') return handleTranslationModels(req, res);
  if (req.method === 'POST' && url === '/api/translate/export') return handleTranslationExportStateless(req, res);
  const translationCancel = /^\/api\/translate\/([a-f0-9]{24})\/cancel$/.exec(url);
  if (req.method === 'POST' && translationCancel) return handleTranslationCancel(req, res, translationCancel[1]);
  const translationEvents = /^\/api\/translate\/([a-f0-9]{24})\/events$/.exec(url);
  if (get && translationEvents) return handleTranslationEvents(req, res, translationEvents[1]);
  const translationExport = /^\/api\/translate\/([a-f0-9]{24})\/export$/.exec(url);
  if ((req.method === 'POST' || get) && translationExport) return handleTranslationExport(req, res, translationExport[1]);
  const translationStatusMatch = /^\/api\/translate\/([a-f0-9]{24})$/.exec(url);
  if (get && translationStatusMatch) return handleTranslationStatus(req, res, translationStatusMatch[1]);

  if (req.method === 'POST' && /^\/api\/(validate|recheck|fix|fix-cast-notes|export|count)$/.test(url)) return handleFormat(req, res, url.slice(5));
  if (get && url === '/api/me') return send(res, 200, { auth: auth.enabled, user: auth.enabled ? auth.user : null }, undefined, { 'Cache-Control': 'no-store' });
  if (get && url === '/healthz') return send(res, 200, { ok: true, pending: pool.pending });
  if (get && statics.has(url)) return serveStatic(res, url);
  send(res, 404, { error: 'not found' });
}

const server = http.createServer(handle);
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `端口 ${PORT} 已被占用，换一个试试：PORT=3001 npm start` : e);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log(`打回编剧重申工作台已启动： http://${HOST}:${server.address().port}${auth.enabled ? '（需登录）' : '（未设置 AUTH，免登录）'}`);
});
