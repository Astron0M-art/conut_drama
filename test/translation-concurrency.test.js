'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createTranslationManager,
  MAX_EPISODES,
  MAX_CONCURRENT_EPISODES,
} = require('../lib/translate');

function payload(count) {
  const paragraphs = ['正文内容'];
  const episodes = [];
  for (let i = 1; i <= count; i += 1) {
    const lines = [`第${i}集`, `${i}-1 日 内 房间`, `甲：第${i}集台词。`];
    const start = paragraphs.length;
    paragraphs.push(...lines);
    episodes.push({ episode: i, text: lines.join('\n'), paragraphIndexes: [start, start + 1, start + 2] });
  }
  return { name: '并发测试', paragraphs, episodes, targetLanguage: '英语', modelKey: 'deepseek' };
}

test('批量翻译支持 100 集，最多 20 集并发，其余排队且单集失败不终止整批', async () => {
  assert.equal(MAX_EPISODES, 100);
  assert.equal(MAX_CONCURRENT_EPISODES, 20);
  let active = 0;
  let maxActive = 0;
  const manager = createTranslationManager({
    bridge: async (episode) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 4));
      active -= 1;
      if (episode.episode === 7) {
        const error = new Error('模拟单集失败');
        error.code = 'simulated_episode_failed';
        throw error;
      }
      return `译文 ${episode.episode}`;
    },
  });
  const started = manager.start(payload(100));
  const events = [];
  manager.subscribe(started.jobId, (event) => { if (event) events.push(event); });
  let job;
  for (let i = 0; i < 200; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    job = manager.get(started.jobId);
    if (job?.finishedAt) break;
  }
  assert.ok(job?.finishedAt, '100 集任务应在测试窗口内结束');
  assert.equal(maxActive, 20, '并发窗口应填满到 20 集');
  assert.equal(job.completed, 99);
  assert.equal(job.failed, 1);
  assert.equal(job.queued, 0);
  assert.equal(job.running, 0);
  assert.equal(job.status, 'failed', '批量终态应等待全部集结束后再标记失败');
  const failedIndex = events.findIndex((event) => event.type === 'episode_failed' && event.episode === 7);
  const jobFailedIndex = events.findIndex((event) => event.type === 'job_failed');
  const lastCompletedIndex = Math.max(...events.map((event, index) => event.type === 'episode_completed' ? index : -1));
  assert.ok(failedIndex >= 0);
  assert.ok(lastCompletedIndex > failedIndex, '单集失败后仍应继续完成其它集');
  assert.ok(jobFailedIndex > lastCompletedIndex, 'job_failed 必须在所有集结束后发出');
  assert.equal(events.filter((event) => event.type === 'episode_started').length, 100);
  assert.equal(events.filter((event) => event.type === 'episode_completed').length, 99);
  assert.equal(events.filter((event) => event.type === 'episode_failed').length, 1);
});
