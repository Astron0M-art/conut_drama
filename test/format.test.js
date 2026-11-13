'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { check, autoFix, validateParagraphs, exportDocx, readParagraphs, validateBuffer } = require('../lib/format');

const REF = path.join(__dirname, 'fixtures', 'reference.docx');
const ref = () => readParagraphs(fs.readFileSync(REF), '.docx');
const codes = (paras) => check(paras).issues.filter((i) => i.level === 'error').map((i) => i.code);
const idx = (paras, re) => paras.findIndex((t) => re.test(t));

test('参考稿本身：0 错误 0 提示，并给出字数统计', () => {
  const r = validateBuffer(fs.readFileSync(REF), 'ref.docx');
  assert.strictEqual(r.format.ok, true);
  assert.strictEqual(r.format.errors + r.format.warns, 0);
  assert.strictEqual(r.analysis.episodes.length, 3);
});

test('格式不通过时不统计字数', () => {
  const p = ref(); p.splice(idx(p, /^正文内容$/), 1);
  const r = validateParagraphs(p);
  assert.strictEqual(r.format.ok, false);
  assert.strictEqual(r.analysis, undefined);
});

test('第N集有标题却没有 N-1 场次，而是 N 的尾数（21 集写成 2-1）', () => {
  const p = ref();
  const i = idx(p, /^第3集$/); p.splice(i, 0, '第21集'); // 模拟：第 21 集标题下接 3-1
  const j = p.findIndex((t) => /^3-1 /.test(t));
  p[j] = p[j].replace(/^3-1/, '1-1');
  const e = check(p).issues.find((x) => x.code === 'scene-episode-mismatch' && x.para === j);
  assert.ok(e, '应报场次集号不符');
});

test('缺少第 N 集标题：场次从 N-1 开始但没有集标题', () => {
  const p = ref(); p.splice(idx(p, /^第2集$/), 1);
  const r = check(p);
  const e = r.issues.find((x) => x.code === 'episode-heading-missing');
  assert.ok(e && e.fixable);
  assert.strictEqual(autoFix(p).report.ok, true);
});

test('缺集：第1集后直接第3集', () => {
  const p = ref(); const i = idx(p, /^第2集$/);
  const end = idx(p, /^第3集$/);
  p.splice(i, end - i);
  assert.ok(codes(p).includes('episode-missing'));
});

test('场次号不连续、集标题带标题、半角冒号、△后空格 → 都能被一键修复，结果通过', () => {
  const p = ref();
  p[idx(p, /^第2集$/)] = '第2集 废料堆奇遇';
  p[idx(p, /^2-2 /)] = p[idx(p, /^2-2 /)].replace('2-2', '2-3');
  p[idx(p, /^短剧类型：/)] = '短剧类型:AI短剧';
  p[idx(p, /^△黑铁被刨出/)] = '△ 黑铁被刨出半截';
  assert.ok(codes(p).length >= 3);
  const f = autoFix(p);
  assert.strictEqual(f.report.ok, true, JSON.stringify(f.report.issues.filter((x) => x.level === 'error')));
  assert.ok(f.paras.includes('第2集') && f.paras.some((t) => t.startsWith('2-2 ')));
});

test('场次头缺人物行 / 未识别的正文行 / 缺章节 / 缺字段', () => {
  let p = ref(); p.splice(idx(p, /^人物：陆铁 赵骁/), 1);
  assert.ok(codes(p).includes('cast-missing'));
  p = ref(); p.splice(idx(p, /^△巨大熔炉/), 0, '这是一句没有标记的旁白。');
  assert.ok(codes(p).includes('body-line-unknown'));
  p = ref(); p.splice(idx(p, /^故事梗概$/), 1);
  assert.ok(codes(p).includes('section-missing'));
  p = ref(); p.splice(idx(p, /^核心亮点：/), 1);
  assert.ok(codes(p).includes('synopsis-missing-field'));
});

test('场次头内/外与时间颠倒、「内/外」合写可接受', () => {
  const p = ref(); p[idx(p, /^1-1 /)] = '1-1 外 日 炼器堂-后院';
  const f = autoFix(p); assert.ok(f.paras.includes('1-1 日 外 炼器堂-后院'));
  const q = ref(); q[idx(q, /^1-1 /)] = '1-1 夜 内/外 炼器堂';
  assert.ok(!codes(q).includes('scene-format'));
});

test('粗纲/集纲与正文集数不一致不算错（只看正文）', () => {
  assert.strictEqual(check(ref()).ok, true);
});

test('导出的 docx 重新读取后段落一致，且重新校验通过、字数一致', () => {
  const a = ref();
  const buf = exportDocx(a);
  const b = readParagraphs(buf, '.docx');
  assert.deepStrictEqual(b, a);
  const v = validateBuffer(buf, 'x.docx');
  assert.strictEqual(v.format.ok, true);
  assert.deepStrictEqual(v.analysis.episodes.map((e) => e.counts), validateBuffer(fs.readFileSync(REF), 'r.docx').analysis.episodes.map((e) => e.counts));
});

test('导出保持参考稿版式：二级标题样式 3、书名样式 2 居中、粗体前缀与空段落', () => {
  const { readAll } = require('../lib/format/zip');
  const xml = readAll(exportDocx(ref())).get('word/document.xml').toString('utf8');
  const refXml = readAll(fs.readFileSync(REF)).get('word/document.xml').toString('utf8');
  const sig = (x) => (x.match(/<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) || []).map((p) => `${(/pStyle w:val="(\d)"/.exec(p) || [])[1] || '-'}${/<w:jc w:val="center"/.test(p) ? 'c' : ''}${/\/>$/.test(p) && !/<\/w:p>/.test(p) ? 'E' : ''}${/<w:b\/>/.test(p) ? 'B' : ''}`).join(',');
  assert.strictEqual(sig(xml), sig(refXml));
});
