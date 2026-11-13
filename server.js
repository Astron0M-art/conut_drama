// 字数统计·打回编剧重申工作台：静态页面 + 登录 + POST /api/analyze（零依赖）
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Pool } = require('./lib/pool');
const { createAuth, Throttle } = require('./lib/auth');
const fmt = require('./lib/format');

const PORT = process.env.PORT === '0' ? 0 : Number(process.env.PORT) || 3000; // PORT=0：随机空闲端口（测试用）
const HOST = process.env.HOST || '127.0.0.1';
const MAX_FILE = 30 * 1024 * 1024; // 单文件上限
const MAX_QUEUE = 64; // 排队中的解析任务上限，超出返回 503
const MAX_PER_IP = 16; // 单 IP 同时在途请求
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

const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const statics = new Map();
for (const f of fs.readdirSync(PUBLIC)) statics.set('/' + f, f);
statics.set('/', 'index.html');
statics.set('/login', 'login.html');
statics.delete('/login.html');
statics.set('/type', 'type.html');
statics.delete('/type.html');
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
    if (kind === 'recheck') return send(res, 200, fmt.validateParagraphs(body.paragraphs, name));
    if (kind === 'fix') return send(res, 200, fmt.fixParagraphs(body.paragraphs, name));
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

async function handleAnalyze(req, res) {
  const ip = clientIp(req);
  if ((inflight.get(ip) || 0) >= MAX_PER_IP || pool.pending >= MAX_QUEUE) {
    return send(res, 503, { error: '服务繁忙，请稍后重试' }, undefined, { 'Retry-After': '3' });
  }
  inflight.set(ip, (inflight.get(ip) || 0) + 1);
  try {
    let name = '';
    try { name = decodeURIComponent(req.headers['x-filename'] || ''); } catch { /* 留空 */ }
    if (!name) return send(res, 400, { error: '缺少文件名' });
    const buf = await readBody(req, MAX_FILE, '文件超过 30MB');
    if (!buf.length) return send(res, 400, { error: '文件内容为空' });
    send(res, 200, await pool.run(buf, name));
  } catch (e) {
    // 解析类错误是用户文件的问题（400），其余才是服务端问题
    const status = e.status || 400;
    if (status === 413) res.once('finish', () => req.destroy()); // 不再接收剩余数据
    send(res, status, { error: e.message || '分析失败' }, undefined, status === 413 ? { Connection: 'close' } : {});
  } finally {
    const n = (inflight.get(ip) || 1) - 1;
    n ? inflight.set(ip, n) : inflight.delete(ip);
  }
}

function handle(req, res) {
  const url = req.url.split('?')[0];
  const get = req.method === 'GET';

  if (req.method === 'POST' && url === '/api/login') return handleLogin(req, res);
  if (req.method === 'POST' && url === '/api/logout') return handleLogout(req, res);

  if (get && url === '/login' && authed(req)) return redirect(res, '/'); // 已登录就不用再看登录页
  if (get && OPEN.has(url)) return serveStatic(res, url);

  if (!authed(req)) {
    // 页面跳登录页；接口和其他资源直接 401
    return get && (url === '/' || url === '/index.html' || url === '/type') ? redirect(res, '/login') : send(res, 401, { error: '未登录' });
  }

  if (req.method === 'POST' && url === '/api/analyze') return handleAnalyze(req, res);
  if (req.method === 'POST' && /^\/api\/(validate|recheck|fix|export)$/.test(url)) return handleFormat(req, res, url.slice(5));
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
