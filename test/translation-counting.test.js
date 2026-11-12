'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { analyzeParagraphs } = require('../lib/episodes');
const { analyzeBuffer } = require('../lib/analyze');

const allCounts = (n) => ({ full: n, clean: n, pure: n });
const oneEpisode = (body) => {
  const result = analyzeParagraphs(['剧本正文', '第1集', ...body]);
  assert.equal(result.episodes.length, 1);
  return result.episodes[0];
};

test('中文正文各口径都排除带语言标签的整块外语翻译，标签和括号也不计数', () => {
  for (const translation of [
    '（西：Salgan de la casa.）',
    '(英: Leave the house.)',
    '（法语：Quittez la maison.）',
    '（日：ここから出てください。）',
    '（韩语：집에서 나가세요.）',
    '（俄语：Выйдите из дома.）',
    '（阿拉伯语：غادر المنزل.）',
  ]) {
    assert.deepEqual(oneEpisode(['Jack刚刚告诉我。', translation]).counts, allCounts(7), translation);
    assert.deepEqual(oneEpisode([translation]).counts, allCounts(0), translation);
  }
});

test('无标签的明显外语句翻译也从整集和纯台词统计中排除', () => {
  for (const translation of ['(Hello, my friend.)', '（Salgan de la casa.）', '(Bonjour mon ami.)']) {
    assert.deepEqual(oneEpisode([`甲：你好。${translation}`]).counts, allCounts(5), translation);
  }
});

test('无标签的短外语回答及译文人名不因长度短而漏入字数', () => {
  for (const translation of ['（No.）', '(Dos.)', '（Ramon.）']) {
    assert.deepEqual(oneEpisode([`甲：你好。${translation}`]).counts, allCounts(5), translation);
  }
});

test('中文动作括号及OS、V.O.保留，夹杂英文人名仍按每词一字', () => {
  const body = ['甲（低声）：走。', '甲（OS）：走。', '甲（V.O.）：走。', 'Jack刚刚告诉我。'];
  // 中文动作8，OS行7，V.O.行10，Jack行7；括号和中文标点仍计数。
  assert.deepEqual(oneEpisode(body).counts, allCounts(32));
  assert.deepEqual(oneEpisode([...body, '（西：Go now.）']).counts, allCounts(32));
  assert.deepEqual(oneEpisode(['甲（看向Jack）：走。']).counts, allCounts(9));
});

test('中文动作中的英文人名、VO标记和道具编号保留', () => {
  // 中文台词5 + 看Diego括号4 + VO括号3 + P03括号3。
  assert.deepEqual(oneEpisode(['甲：你好。', '（看Diego）', '（VO）', '（P03）']).counts, allCounts(15));
  // 日/韩人名也不能导致整段中文动作被误删；此处非拉丁外语字符本身不计数。
  assert.deepEqual(oneEpisode(['甲（看向ジョン）：走。']).counts, allCounts(8));
  assert.deepEqual(oneEpisode(['甲（举起뭐）：走。']).counts, allCounts(8));
});

test('动作标记△本身不计字数，动作文字和相邻中文台词继续统计', () => {
  assert.deepEqual(oneEpisode(['△甲推门。', '△', '甲：Jack来了。']).counts, allCounts(10));
  assert.deepEqual(oneEpisode(['甲推门。', '甲：Jack来了。']).counts, allCounts(10));
});

test('嵌套和半全角括号的外语翻译整块排除，保留两侧中文正文', () => {
  for (const translation of [
    '（西：Please (sit down) now.）',
    '(英：Please （sit down） now.)',
    '（法语：Venez (tout de suite).）',
  ]) {
    assert.deepEqual(oneEpisode([`甲：请坐。${translation}乙：再见。`]).counts, allCounts(10), translation);
  }
});

test('跨段翻译中的假集标题和场次号不拆正文，也不泄漏翻译尾部', () => {
  const result = analyzeBuffer(Buffer.from([
    '分集大纲', '第41集 大纲', '这段大纲不计数。',
    '剧本正文', '第1集', '甲：你好。',
    '（西：Hello,', '第9集', '9-1 Night room', 'world.）',
    '1-2 夜 外 家', '乙：再见。',
    '第2集', '2-1 日 内 家', '甲：Jack来了。',
  ].join('\n')), 'synthetic-multiline-translation.txt');
  assert.deepEqual(result.episodes.map((episode) => episode.no), [1, 2]);
  assert.deepEqual(result.episodes.map((episode) => episode.scenes), [1, 1]);
  assert.deepEqual(result.episodes.map((episode) => episode.counts), [
    { full: 14, clean: 14, pure: 10 },
    { full: 10, clean: 10, pure: 6 },
  ]);
  assert.deepEqual(result.issues, []);
});

test('缺少集标题时同集多个场次累计，外语翻译不影响中文判定和去场次统计', () => {
  const result = analyzeParagraphs([
    '剧本正文', '2-1 日 内 家', '甲：你好。', '(西: Hola.)',
    '2-2 夜 外 家', '乙：再见。', '（英：Goodbye.）',
  ]);
  assert.equal(result.lang, 'zh');
  assert.deepEqual(result.episodes.map((episode) => episode.no), [2]);
  assert.equal(result.episodes[0].scenes, 2);
  assert.deepEqual(result.episodes[0].counts, { full: 18, clean: 18, pure: 10 });
});

test('正文起点优先于翻译过滤，前言括号不能吞掉剧本正文', () => {
  const result = analyzeParagraphs([
    '前言（西：unfinished note', '剧本正文', '第1集', '甲（低声）：走。',
  ]);
  assert.equal(result.episodes.length, 1);
  assert.deepEqual(result.episodes[0].counts, allCounts(8));
});

test('纯英文剧本沿用英文词规则，英文括号动作不误当成双语翻译', () => {
  const result = analyzeParagraphs([
    '剧本正文', '第1集', '1-1 夜 内 ROOM', '人物：Alice',
    'Alice: Hello, world! (She opens the door.) 123 I a',
  ]);
  assert.equal(result.lang, 'en');
  assert.deepEqual(result.episodes[0].counts, { full: 9, clean: 9, pure: 7 });
});

test('实际前端默认整集口径和CSV按去翻译后的550字判定合格', () => {
  const body = `${'甲'.repeat(549)} Jack（西：${'Hola '.repeat(600)}.）`;
  const book = {
    id: 1, name: '翻译计数验收', status: 'done',
    file: { name: 'translation-boundary.txt', size: Buffer.byteLength(body) },
    result: analyzeBuffer(Buffer.from(`剧本正文\n第1集\n${body}`), 'translation-boundary.txt'),
  };
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const context = vm.createContext({ book, innerWidth: 1024, document: { getElementById: () => ({ clientWidth: 900 }) } });
  vm.runInContext(source.slice(0, source.indexOf('/* ---------------- 事件')), context);
  vm.runInContext('state.books = [book]', context);
  assert.equal(vm.runInContext('state.caliber', context), 'full');
  assert.equal(vm.runInContext('summarize(book).eps[0].n', context), 550);
  assert.equal(vm.runInContext('summarize(book).eps[0].v.kind', context), 'ok');
  assert.match(vm.runInContext('bookHTML(book)', context), /全部集数字数合格/);
  assert.match(vm.runInContext('csvText()', context), /"550","550","合格","0"/);
});
