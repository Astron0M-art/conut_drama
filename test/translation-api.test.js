// 翻译 API 最小烟测：正文分集提交 → mock SSE → 整本 DOCX 导出。
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { readParagraphs } = require('../lib/format/read');
const { createTranslationManager, normalizePayload, canonicalModel, MODEL_KEYS } = require('../lib/translate');

const SERVER = require('node:path').join(__dirname, '..', 'server.js');
let child;
let base;
let cookie;

before(async () => {
  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: '0', HOST: '127.0.0.1', AUTH: 'admin:translate-test', SESSION_SECRET: 'translate-secret',
      TRANSLATION_MOCK: '1',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  base = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('翻译测试服务启动超时')), 8000);
    child.stdout.on('data', (data) => {
      output += data;
      const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`服务提前退出 (${code})：${output}`)); });
  });
  const login = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'translate-test' }),
  });
  assert.strictEqual(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
});

after(() => child && child.kill());

function body() {
  const paragraphs = [
    '《翻译测试》', '正文内容', '第1集', '1-1 日 内 房间', '人物：甲', '△甲走进房间。', '甲：你好。',
    '第2集', '2-1 日 外 门口', '人物：乙', '乙：继续。',
  ];
  return {
    name: '翻译测试', paragraphs,
    episodes: [
      { episode: 1, text: paragraphs.slice(3, 7).join('\n'), paragraphIndexes: [3, 4, 5, 6] },
      { episode: 2, text: paragraphs.slice(7, 11).join('\n'), paragraphIndexes: [7, 8, 9, 10] },
    ],
    targetLanguage: '英语', modelKey: 'deepseek', flow: 'original', dramaType: 'animeShortDrama',
  };
}

test('中文剧本已有的括号外语译文不重复送入模型，英文正文动作括号保留', () => {
  const base = body();
  const normalized = normalizePayload({
    ...base,
    episodes: [{
      episode: 1,
      text: `${base.episodes[0].text}（西：Hola, abre la puerta.）`,
      paragraphIndexes: base.episodes[0].paragraphIndexes,
    }],
  });
  assert.doesNotMatch(normalized.episodes[0].text, /Hola/);
  const english = normalizePayload({
    ...base,
    paragraphs: ['正文内容', '第1集', '1-1 INT. ROOM', 'Alice: (Open the door.)'],
    episodes: [{ episode: 1, text: '1-1 INT. ROOM\nAlice: (Open the door.)', paragraphIndexes: [2, 3] }],
  });
  assert.match(english.episodes[0].text, /Open the door/);
});

test('11 个精确模型 ID 都能通过正文翻译请求归一化，旧简称仍兼容', () => {
  const models = Object.keys(MODEL_KEYS);
  assert.strictEqual(models.length, 11);
  for (const modelKey of models) {
    const normalized = normalizePayload({ ...body(), modelKey });
    assert.strictEqual(normalized.model.key, modelKey);
    assert.strictEqual(canonicalModel(modelKey.toUpperCase()).key, modelKey);
  }
  for (const [alias, expected] of [
    ['deepseek', 'ds-v4.1-flash'], ['gemini', 'gemini-4-argon'],
    ['claude', 'claude-sonnet-5-5'], ['gpt', 'gpt-6.1-terra'],
  ]) assert.strictEqual(canonicalModel(alias).key, expected);
});

test('无效模型 key 在服务端拦截，且翻译接口需要登录', async () => {
  const unauth = await fetch(`${base}/api/translate/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body()),
  });
  assert.strictEqual(unauth.status, 401);
  const invalid = await fetch(`${base}/api/translate/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ ...body(), modelKey: 'https://evil.example/key' }),
  });
  assert.strictEqual(invalid.status, 400);
  assert.match((await invalid.json()).error, /白名单/);
});

test('mock 翻译逐集串行推送 SSE，并可导出包含原文和译文的 DOCX', async () => {
  const started = await fetch(`${base}/api/translate/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body()),
  });
  assert.strictEqual(started.status, 202);
  const { jobId } = await started.json();
  assert.match(jobId, /^[a-f0-9]{24}$/);

  const stream = await fetch(`${base}/api/translate/${jobId}/events`, { headers: { Cookie: cookie } });
  assert.strictEqual(stream.status, 200);
  const text = await stream.text();
  assert.match(text, /event: episode_started/);
  assert.match(text, /event: episode_completed/);
  assert.match(text, /MOCK-英语/);
  assert.match(text, /event: job_completed/);

  const status = await fetch(`${base}/api/translate/${jobId}`, { headers: { Cookie: cookie } });
  const statusJson = await status.json();
  assert.strictEqual(statusJson.status, 'succeeded');
  assert.strictEqual(statusJson.completed, 2);
  assert.strictEqual(statusJson.results.length, 2);

  const exported = await fetch(`${base}/api/translate/${jobId}/export`, {
    method: 'POST', headers: { Cookie: cookie },
  });
  assert.strictEqual(exported.status, 200);
  assert.match(exported.headers.get('content-type'), /wordprocessingml\.document/);
  const docx = Buffer.from(await exported.arrayBuffer());
  assert.strictEqual(docx.subarray(0, 2).toString(), 'PK');
  const out = readParagraphs(docx, '.docx');
  assert.ok(out.some((line) => line.includes('甲：你好。')));
  assert.ok(out.some((line) => line.includes('MOCK-英语')));
  assert.ok(out.some((line) => line.includes('乙：继续。')));
});

test('真实桥接未配置凭据时任务失败并给出明确错误码', async () => {
  const manager = createTranslationManager({ mock: false, token: '', url: 'http://127.0.0.1:1' });
  const payload = body();
  const started = manager.start({ ...payload, episodes: [payload.episodes[0]] });
  let job;
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    job = manager.get(started.jobId);
    if (job && job.status === 'failed') break;
  }
  assert.strictEqual(job.status, 'failed');
  assert.strictEqual(job.error.code, 'translation_bridge_not_configured');
  assert.match(job.error.message, /翻译服务凭据/);
});

test('未提供 paragraphIndexes 时直接替换原正文，不增加重复译文块', async () => {
  const manager = createTranslationManager({ mock: true });
  const paragraphs = [
    '《定位测试》', '正文内容', '第1集', '1-1 日 内 房间', '甲：你好。（西：Hola）',
    '第2集', '2-1 日 外 门口', '乙：继续。',
  ];
  const payload = {
    name: '定位测试', paragraphs,
    episodes: [
      { episode: 1, text: paragraphs.slice(2, 5).join('\n') },
      { episode: 2, text: paragraphs.slice(5, 8).join('\n') },
    ],
    targetLanguage: '英语', modelKey: 'deepseek',
  };
  const started = manager.start(payload);
  let job;
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    job = manager.get(started.jobId);
    if (job && job.status === 'succeeded') break;
  }
  assert.strictEqual(job.status, 'succeeded');
  const out = readParagraphs(manager.export(started.jobId).buffer, '.docx');
  const first = out.findIndex((line) => line.includes('第1集'));
  const secondHeading = out.findIndex((line) => line.includes('第2集'));
  assert.ok(first >= 0 && secondHeading >= 0 && first < secondHeading);
  assert.equal(out.filter((line) => line.includes('【译文·英语】')).length, 0);
  assert.equal(out.filter((line) => line.includes('甲：你好')).length, 1);
});

test('人物行身份注释未清理时，翻译开始和导出都拒绝', () => {
  const dirty = body();
  dirty.paragraphs[4] = '人物：甲（24岁，促销员）、乙';
  assert.throws(() => normalizePayload(dirty), (error) => error.status === 422 && error.code === 'cast_notes_blocked');
  const manager = createTranslationManager({ mock: true });
  assert.throws(() => manager.exportFromPayload({ ...dirty, translations: { 1: '译文' } }), (error) => error.code === 'cast_notes_blocked');
});

test('HTTP：模型可用性、无状态整本导出、停止任务；未登录一律 401', async () => {
  const get = (p, headers = {}) => fetch(base + p, { headers });
  const post = (p, bodyObj, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(bodyObj) });

  assert.strictEqual((await get('/api/translate/models')).status, 401);
  assert.strictEqual((await post('/api/translate/export', {})).status, 401);

  const models = await (await get('/api/translate/models', { Cookie: cookie })).json();
  assert.strictEqual(models.mock, true);
  assert.ok(models.models.length === 11 && models.models.every((m) => m.configured === true));
  assert.doesNotMatch(JSON.stringify(models), /https?:|sk-|apiKey|token|ep-[a-z0-9]{6}/i); // 无地址、密钥、endpoint ID

  const payload = body();
  const exported = await post('/api/translate/export', {
    ...payload, episodes: [payload.episodes[0]], translations: { 1: '第1集\n1-1 INT. ROOM\nA: Hello.' }, mode: 'replace',
  }, { Cookie: cookie });
  assert.strictEqual(exported.status, 200);
  assert.match(exported.headers.get('content-type'), /wordprocessingml/);
  const lines = readParagraphs(Buffer.from(await exported.arrayBuffer()), '.docx');
  assert.ok(lines.includes('A: Hello.'));
  assert.ok(lines.includes('乙：继续。'), '未提交译文的第 2 集保留原文');

  const empty = await post('/api/translate/export', { ...payload, translations: {} }, { Cookie: cookie });
  assert.strictEqual(empty.status, 409);
  assert.strictEqual((await empty.json()).code, 'translation_empty');

  const started = await (await post('/api/translate/start', payload, { Cookie: cookie })).json();
  const cancel = await post(`/api/translate/${started.jobId}/cancel`, {}, { Cookie: cookie });
  assert.strictEqual(cancel.status, 200);
  assert.strictEqual((await post('/api/translate/ffffffffffffffffffffffff/cancel', {}, { Cookie: cookie })).status, 404);
});
