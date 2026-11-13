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

test('场次号不连续、集标题带标题、半角冒号、△后空格：只是提示，不拦截，且都能一键修复', () => {
  const p = ref();
  p[idx(p, /^第2集$/)] = '第2集 废料堆奇遇';
  p[idx(p, /^2-2 /)] = p[idx(p, /^2-2 /)].replace('2-2', '2-3');
  p[idx(p, /^△黑铁被刨出/)] = '△ 黑铁被刨出半截';
  const r = check(p);
  assert.strictEqual(r.ok, true);
  assert.ok(r.warns >= 3 && r.fixable >= 3);
  const f = autoFix(p);
  assert.strictEqual(f.report.warns, 0);
  assert.ok(f.paras.includes('第2集') && f.paras.some((t) => t.startsWith('2-2 ')));
});

test('场次头缺人物行 / 未识别的正文行 / 梗概缺字段 / 人物小传格式乱：只做提示，不影响统计', () => {
  let p = ref(); p.splice(idx(p, /^人物：陆铁 赵骁/), 1);
  let r = check(p); assert.ok(r.ok && r.issues.some((i) => i.code === 'cast-missing' && i.level === 'warn'));
  p = ref(); p.splice(idx(p, /^△巨大熔炉/), 0, '这是一句没有标记的旁白。');
  r = check(p); assert.ok(r.ok && r.issues.some((i) => i.code === 'body-line-unknown' && i.level === 'warn'));
  p = ref(); p.splice(idx(p, /^核心亮点：/), 1);
  assert.strictEqual(check(p).issues.length, 0); // 梗概缺字段不再校验
  p = ref(); p.splice(idx(p, /^故事梗概$/), 1, '一些乱七八糟的东西');
  assert.strictEqual(check(p).ok, true);
});

test('只有影响分集的才是错误：缺「正文内容」标题、缺集标题、缺集、集号重复/倒退、空集', () => {
  let p = ref(); p.splice(idx(p, /^正文内容$/), 1);
  assert.ok(codes(p).includes('section-missing'));
  p = ref(); p.splice(idx(p, /^第2集$/), 1);
  assert.ok(codes(p).includes('episode-heading-missing'));
  p = ref(); const i = idx(p, /^第2集$/); p.splice(i, idx(p, /^第3集$/) - i);
  assert.ok(codes(p).includes('episode-missing'));
});

test('字数只统计「正文内容」之后：前面的梗概、人物、大纲乱写也不影响各集字数', () => {
  const base = validateParagraphs(ref()).analysis.episodes.map((e) => e.counts.full);
  const p = ref(); const b = idx(p, /^正文内容$/);
  p.splice(1, b - 1, '随便写的一大段无关文字'.repeat(300), '第99集 假的集标题', '99-1 日 外 假场次');
  const r = validateParagraphs(p);
  assert.strictEqual(r.format.ok, true);
  assert.deepStrictEqual(r.analysis.episodes.map((e) => e.counts.full), base);
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
