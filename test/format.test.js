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

test('场次号不连续、集标题带标题、半角冒号：只是提示，不拦截，且都能一键修复；△后空格直接放过', () => {
  const p = ref();
  p[idx(p, /^第2集$/)] = '第2集 废料堆奇遇';
  p[idx(p, /^2-2 /)] = p[idx(p, /^2-2 /)].replace('2-2', '2-3');
  p[idx(p, /^△黑铁被刨出/)] = '△ 黑铁被刨出半截';
  const r = check(p);
  assert.strictEqual(r.ok, true);
  assert.ok(!r.issues.some((i) => i.para === idx(p, /^△ 黑铁被刨出/)), '△后空格不应有任何提示');
  assert.ok(r.warns >= 2 && r.fixable >= 2);
  const f = autoFix(p);
  assert.strictEqual(f.report.warns, 0);
  assert.ok(f.paras.includes('第2集') && f.paras.some((t) => t.startsWith('2-2 ')));
});

test('场次头缺人物行只做提示；未识别的正文行、【闪回】标记行直接放过（无提示）；梗概/人物小传乱不影响', () => {
  let p = ref(); p.splice(idx(p, /^人物：陆铁 赵骁/), 1);
  let r = check(p); assert.ok(r.ok && r.issues.some((i) => i.code === 'cast-missing' && i.level === 'warn'));
  p = ref(); p.splice(idx(p, /^△巨大熔炉/), 0, '这是一句没有标记的旁白。');
  r = check(p); assert.ok(r.ok && r.issues.length === 0);
  p = ref(); p.splice(idx(p, /^△巨大熔炉/), 0, '【闪回结束】岑书禾脊背挺拔，神色没有半分退缩。', '【闪回】');
  r = check(p); assert.ok(r.ok && r.issues.length === 0);
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

test('框选字数：选中整集 = 该集统计；与逐集同口径（排除外译与△），空选为 0', () => {
  const { countSelection } = require('../lib/episodes');
  const p = ref(); const r = validateParagraphs(p);
  const eps = r.format.blocks.filter((b) => b.kind === 'ep').map((b) => b.para);
  const body = p.slice(eps[0] + 1, eps[1]);
  const c = countSelection(body, 'zh');
  assert.strictEqual(c.full, r.analysis.episodes[0].counts.full);
  assert.strictEqual(c.pure, r.analysis.episodes[0].counts.pure);
  assert.strictEqual(countSelection(['△你好，世界！'], 'zh').full, 6); // △ 不计
  assert.strictEqual(countSelection(['甲（笑）：好的。(Sí, claro que sí.)'], 'zh').full, countSelection(['甲（笑）：好的。'], 'zh').full); // 外译不计
  assert.strictEqual(countSelection([], 'zh').full, 0);
});

test('独立成行的「（中：…）」译文行：保留，不提示不报错，一键修复也不删除', () => {
  const t = '（中：编号 C-0902号受试体：测试同理心崩溃极限。成年即刻执行分子粉碎销毁。）';
  const p = ref(); p.splice(idx(p, /^△巨大熔炉/), 0, '【OVERRIDE： HUMAN SOVEREIGNTY】', t);
  const r = check(p);
  assert.ok(r.ok && r.issues.length === 0);
  assert.ok(autoFix(p).paras.includes(t));
});
