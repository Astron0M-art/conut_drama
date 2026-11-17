'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LEVELS } = require('../lib/translation-provider');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('唯一目标语言下拉框的八种语言与后端映射一致', () => {
  const html = read('public/type-translate.html');
  const controls = [...html.matchAll(/<select\b[^>]*\bid="targetLanguage"[^>]*>([\s\S]*?)<\/select>/g)];
  assert.equal(controls.length, 1);
  const options = [...controls[0][1].matchAll(/<option\b[^>]*\bvalue="([^"]+)"[^>]*>([^<]+)<\/option>/g)];
  assert.equal(options.length, 8);
  const languages = options.map((option) => option[1]);
  assert.equal(new Set(languages).size, 8);
  assert.deepEqual([...languages].sort(), Object.keys(LEVELS).sort());
  for (const option of options) assert.equal(option[2].trim(), option[1]);
  assert.ok(languages.includes('菲律宾语'));
  assert.ok(languages.includes('马来语'));
});

test('正文翻译页是独立页面，并暴露两个静态入口', () => {
  const html = read('public/type-translate.html');
  const typeHtml = read('public/type.html');
  const js = read('public/type-translate.js');
  const server = read('server.js');
  assert.match(html, /type-translate\.css/);
  assert.match(html, /type-translate\.js/);
  assert.match(html, /格式校验与字数统计请回到「字数统计」页/);
  assert.match(server, /statics\.set\('\/type-translate', 'type-translate\.html'\)/);
  assert.match(server, /statics\.set\('\/translate', 'type-translate\.html'\)/);
  assert.match(server, /statics\.set\('\/type', 'type\.html'\)/);
  assert.match(js, /\/api\/translate\/start/);
  assert.match(js, /\/api\/translate\/\$\{encodeURIComponent\(jobId\)\}\/events/);
  assert.match(js, /\/api\/translate\/export/); // 无状态整本导出：译文随请求提交
  assert.match(js, /\/api\/translate\/\$\{encodeURIComponent\(state\.jobId\)\}\/cancel/);
  assert.match(js, /\/api\/translate\/models/);
  assert.match(js, /modelKey/);
  assert.match(js, /targetLanguage/);
  // 表头只保留跳到另一个页面的一个按钮（+ 退出登录），且放在布局流里不叠压
  assert.match(typeHtml, /class="hero-nav"[\s\S]*href="\/type-translate"[^>]*>正文翻译 →<\/a>/);
  assert.doesNotMatch(typeHtml, /批量字数统计/);
  assert.equal((typeHtml.match(/class="logout" href=/g) || []).length, 1);
  assert.match(html, /class="hero-nav"[\s\S]*href="\/type"[^>]*>← 字数统计<\/a>/);
  assert.equal((html.match(/class="logout" href=/g) || []).length, 1);
  assert.equal((html.match(/id="targetLanguage"/g) || []).length, 1);
  assert.match(html, /id="sourceCard"/);
  assert.match(html, /id="sourceScroll"/);
  assert.match(html, /id="episodeGapWarning"/);
  assert.match(js, /sourceScrollTo/);
  assert.match(js, /syncActiveSourceFromScroll/);
  assert.match(js, /scrollIntoView/);
  assert.match(js, /missingEpisodeNumbers/);
  assert.match(js, /保留中文原文/);
  assert.match(html, /id="exportMode"/);
  assert.match(html, /覆盖原正文（新文件）/);
  assert.match(html, /保留原文并附译文（新文件）/);
  assert.match(js, /mode: \$\('exportMode'\)\.value/);
});

test('翻译页展示配置中的精确模型 ID，且没有改写原 type 页面脚本', () => {
  const html = read('public/type-translate.html');
  const js = read('public/type-translate.js');
  for (const model of [
    'ds-v4.1-flash', 'ds-v4-flash-0731', 'glm5.3', 'glm5.3-flash',
    'gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.7-flash',
    'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6', 'gpt-6.1-terra',
  ]) {
    const escaped = model.replace(/\./g, '\\.');
    assert.match(html, new RegExp(`value="${escaped}"`));
  }
  assert.doesNotMatch(html, /value="(?:deepseek|gemini|claude|gpt)"/);
  assert.doesNotMatch(js, /type\.js/);
});
