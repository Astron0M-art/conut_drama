'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readParagraphs } = require('../lib/format/read');
const { createTranslationManager } = require('../lib/translate');
const { localModel, cozePrompt, modelAvailability } = require('../lib/translation-provider');

const originalFetch = global.fetch;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function script(count) {
  const paragraphs = ['《稳健测试》', '正文内容'];
  const episodes = [];
  for (let i = 1; i <= count; i += 1) {
    const lines = [`第${i}集`, `${i}-1 日 内 房间`, `人物：甲`, `甲：第${i}集台词。`];
    const start = paragraphs.length;
    paragraphs.push(...lines);
    episodes.push({ episode: i, text: lines.join('\n'), paragraphIndexes: lines.map((_, k) => start + k) });
  }
  return { name: '稳健测试', paragraphs, episodes, targetLanguage: '英语', modelKey: 'deepseek' };
}

async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = fn(); if (value) return value; await wait(5); }
  throw new Error('等待超时');
}

function withEnv(patch, fn) {
  const snapshot = Object.fromEntries(Object.keys(patch).map((key) => [key, process.env[key]]));
  Object.assign(process.env, patch);
  const restore = () => { for (const [k, v] of Object.entries(snapshot)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  return fn().finally(restore);
}

test('模型调用：429/5xx 这类暂时性故障自动重试，成功后返回译文', () => withEnv({
  STORYPLAY_VAPI_API_KEY: 'k', STORYPLAY_VAPI_BASE_URL: 'https://vapi.test/v1', STORYPLAY_OVERSEAS_PROVIDER: 'vapi',
}, async () => {
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls < 3) return new Response('busy', { status: calls === 1 ? 429 : 503 });
    return new Response(JSON.stringify({ choices: [{ message: { content: '译文' }, finish_reason: 'stop' }] }), { status: 200 });
  };
  try {
    const text = await localModel({ system: 's', user: 'u' }, 'claude-sonnet-5-5', { timeoutMs: 1000, retryDelays: [1, 1] });
    assert.equal(text, '译文');
    assert.equal(calls, 3);
  } finally { global.fetch = originalFetch; }
}));

test('模型调用：401 等永久错误不重试；译文被 length 截断时报错而不是悄悄交出半截', () => withEnv({
  STORYPLAY_VAPI_API_KEY: 'k', STORYPLAY_VAPI_BASE_URL: 'https://vapi.test/v1', STORYPLAY_OVERSEAS_PROVIDER: 'vapi',
}, async () => {
  let calls = 0;
  global.fetch = async () => { calls += 1; return new Response('no', { status: 401 }); };
  try {
    await assert.rejects(localModel({ system: 's', user: 'u' }, 'claude-sonnet-5-5', { timeoutMs: 1000, retryDelays: [1, 1] }), (e) => e.code === 'translation_model_failed');
    assert.equal(calls, 1);
    global.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '半截' }, finish_reason: 'length' }] }), { status: 200 });
    await assert.rejects(localModel({ system: 's', user: 'u' }, 'claude-sonnet-5-5', { timeoutMs: 1000 }), (e) => e.code === 'translation_truncated');
  } finally { global.fetch = originalFetch; }
}));

test('Coze 工作流返回 502 会重试', async () => {
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response('bad gateway', { status: 502 });
    const body = JSON.stringify({ output: { system: 'S', user: 'U' } });
    return new Response(`event: Message\ndata: ${JSON.stringify({ content: body })}\n\n`, { status: 200 });
  };
  try {
    const prompt = await cozePrompt({ text: '第1集' }, { targetLanguage: '英语' }, { cozeToken: 't', timeoutMs: 1000, retryDelays: [1] });
    assert.equal(prompt.system, 'S');
    assert.equal(calls, 2);
  } finally { global.fetch = originalFetch; }
});

test('模型可用性只返回布尔值，不泄漏密钥或地址', () => withEnv({
  STORYPLAY_VAPI_API_KEY: 'SECRET-VAPI', STORYPLAY_TENCENCLOUD_API_KEY: '', COZE_PAT: 'SECRET-COZE', STORYPLAY_OVERSEAS_PROVIDER: 'vapi',
}, async () => {
  const info = modelAvailability();
  assert.equal(info.coze, true);
  assert.equal(info.models.find((m) => m.key === 'claude-sonnet-5-5').configured, true);
  assert.equal(info.models.find((m) => m.key === 'ds-v4.1-flash').configured, false);
  assert.equal(info.models.find((m) => m.key === 'ds-v4.1-flash').region, 'domestic');
  assert.doesNotMatch(JSON.stringify(info), /SECRET|https?:/);
}));

test('开始前预检：缺 Coze 或缺所选模型密钥时立即 503，不创建任务', () => withEnv({
  COZE_PAT: '', STORYPLAY_COZE_API_TOKEN: '', STORYPLAY_COZE_PAT: '', STORYPLAY_TENCENCLOUD_API_KEY: 'k',
}, async () => {
  const manager = createTranslationManager({ mock: false });
  assert.throws(() => manager.preflight(script(1)), (e) => e.status === 503 && e.code === 'translation_bridge_not_configured' && /Coze/.test(e.message));
  process.env.COZE_PAT = 'c';
  process.env.STORYPLAY_TENCENCLOUD_API_KEY = '';
  assert.throws(() => manager.preflight(script(1)), (e) => e.status === 503 && /ds-v4\.1-flash/.test(e.message));
  process.env.STORYPLAY_TENCENCLOUD_API_KEY = 'k';
  assert.doesNotThrow(() => manager.preflight(script(1)));
  assert.doesNotThrow(() => createTranslationManager({ mock: true }).preflight(script(1))); // 演示模式不需要密钥
}));

test('停止：不再启动新的集，在途的集译文保留，终态为 cancelled', async () => {
  let started = 0;
  const manager = createTranslationManager({
    bridge: async (episode) => { started += 1; await wait(30); return `译文 ${episode.episode}`; },
  });
  const { jobId } = manager.start(script(60));
  const events = [];
  manager.subscribe(jobId, (event) => { if (event) events.push(event); });
  await until(() => started >= 20);
  manager.cancel(jobId);
  const job = await until(() => { const j = manager.get(jobId); return j.finishedAt ? j : null; });
  assert.equal(job.status, 'cancelled');
  assert.ok(started < 60, '停止后不应继续启动剩余集');
  assert.equal(job.completed, started, '已发出的集都应完成并保留译文');
  const cancelled = events.find((e) => e.type === 'job_cancelled');
  assert.ok(cancelled && cancelled.cancelledEpisodes.length === 60 - started);
  assert.equal(job.queued, 0);
});

test('跨任务并发闸门：多个任务叠加也不超过全局上限', async () => {
  let active = 0; let max = 0;
  const manager = createTranslationManager({
    bridge: async () => { active += 1; max = Math.max(max, active); await wait(8); active -= 1; return '译文'; },
  });
  const ids = [manager.start(script(30)).jobId, manager.start(script(30)).jobId, manager.start(script(30)).jobId];
  await until(() => ids.every((id) => manager.get(id).finishedAt), 5000);
  assert.ok(max <= 40, `全局并发 ${max} 超过 40`);
  assert.ok(max > 20, '多个任务应能共享到超过单任务窗口的并发');
  assert.ok(ids.every((id) => manager.get(id).status === 'succeeded'));
});

test('无状态整本导出：只提交已完成的集；未翻译的集保留原文；两种导出方式都可用', () => {
  const manager = createTranslationManager({ mock: true });
  const base = script(3);
  const episodes = [base.episodes[0], base.episodes[2]]; // 第 2 集没翻译
  const payload = { ...base, episodes, translations: { 1: '第1集\n1-1 INT.\nA: line one.', 3: '第3集\n3-1 INT.\nA: line three.' } };
  const replaced = manager.exportFromPayload({ ...payload, mode: 'replace' });
  assert.deepEqual(replaced.missingEpisodes, []); // 提交的集都有译文
  const out = readParagraphs(replaced.buffer, '.docx');
  assert.ok(out.includes('A: line one.') && out.includes('A: line three.'));
  assert.ok(out.includes('甲：第2集台词。'), '没提交的第 2 集保留中文原文');
  assert.ok(!out.includes('甲：第1集台词。'), '已翻译的第 1 集原文被替换');
  const both = readParagraphs(manager.exportFromPayload({ ...payload, mode: 'bilingual' }).buffer, '.docx');
  assert.ok(both.includes('甲：第1集台词。') && both.some((l) => l.includes('【译文·英语】')));
  // 提交了集但没有译文 → 记为缺失
  const partial = manager.exportFromPayload({ ...base, translations: { 2: '第2集\nA: two.' } });
  assert.deepEqual(partial.missingEpisodes, [1, 3]);
  assert.throws(() => manager.exportFromPayload({ ...base, translations: {} }), (e) => e.status === 409 && e.code === 'translation_empty');
});

test('已结束任务留存有上限，不会无限占内存', async () => {
  const manager = createTranslationManager({ bridge: async () => '译文' });
  const ids = [];
  for (let i = 0; i < 50; i += 1) {
    const { jobId } = manager.start(script(1));
    ids.push(jobId);
    await until(() => manager.get(jobId) && manager.get(jobId).finishedAt);
  }
  manager.get(ids[0]);
  const alive = ids.filter((id) => manager.get(id));
  assert.ok(alive.length <= 40, `留存 ${alive.length} 个`);
  assert.ok(manager.get(ids[ids.length - 1]), '最新任务应保留');
});
