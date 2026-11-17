'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTranslationManager } = require('../lib/translate');
const { readParagraphs } = require('../lib/format/read');

function payload() {
  const paragraphs = ['正文内容', '第1集', '甲：一', '第2集', '乙：二', '第3集', '丙：三'];
  return {
    name: '完整性测试', paragraphs,
    episodes: [
      { episode: 1, text: '第1集\n甲：一', paragraphIndexes: [1, 2] },
      { episode: 2, text: '第2集\n乙：二', paragraphIndexes: [3, 4] },
      { episode: 3, text: '第3集\n丙：三', paragraphIndexes: [5, 6] },
    ],
    targetLanguage: '英语', modelKey: 'ds-v4.1-flash',
  };
}

test('导出拒绝缺失译文并返回缺失集号', async () => {
  const manager = createTranslationManager({
    bridge: async (episode) => {
      if (episode.episode === 2) throw Object.assign(new Error('模拟失败'), { code: 'mock_failed' });
      return `第${episode.episode}集译文`;
    },
  });
  const started = manager.start(payload());
  for (let i = 0; i < 100; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    const job = manager.get(started.jobId);
    if (job && job.finishedAt) break;
  }
  const job = manager.get(started.jobId);
  assert.equal(job.status, 'failed');
  assert.deepEqual([...job.errors.keys()], [2]);
  assert.throws(() => manager.export(started.jobId), (error) => {
    assert.equal(error.code, 'translation_incomplete');
    assert.deepEqual(error.missingEpisodes, [2]);
    assert.match(error.message, /第2集/);
    return true;
  });
});

test('导出默认覆盖原正文，也支持保留原文附译文', async () => {
  const manager = createTranslationManager({
    bridge: async (episode) => `<第${episode.episode}集>\n译文${episode.episode}`,
  });
  const started = manager.start(payload());
  for (let i = 0; i < 100; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    if (manager.get(started.jobId)?.finishedAt) break;
  }
  const replaced = readParagraphs(manager.export(started.jobId).buffer, '.docx');
  assert.ok(replaced.includes('第1集'));
  assert.ok(replaced.includes('译文1'));
  assert.equal(replaced.includes('甲：一'), false);
  assert.equal(replaced.some((line) => line.includes('【译文·')), false);
  const bilingual = readParagraphs(manager.export(started.jobId, { mode: 'bilingual' }).buffer, '.docx');
  assert.ok(bilingual.includes('甲：一'));
  assert.ok(bilingual.some((line) => line.includes('【译文·英语】第1集')));
});

