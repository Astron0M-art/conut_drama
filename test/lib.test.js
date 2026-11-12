'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { countWords, countChineseDrama } = require('../lib/wps');
const { analyzeParagraphs, stripTranslations, toNumber } = require('../lib/episodes');
const { analyzeBuffer } = require('../lib/analyze');

test('WPS 字数：汉字/中文标点各 1，英文词 ≥2 字母算 1，数字与半角标点不计', () => {
  assert.strictEqual(countWords('你好，世界！'), 6);
  assert.strictEqual(countWords('Hello world'), 2);
  assert.strictEqual(countWords('a I 123 ... don\'t well-known'), 2);
  assert.strictEqual(countWords('  \n\t　'), 0);
  assert.strictEqual(countWords(''), 0);
});

test('中文集号换算', () => {
  assert.strictEqual(toNumber('12'), 12);
  assert.strictEqual(toNumber('十二'), 12);
  assert.strictEqual(toNumber('二十'), 20);
  assert.strictEqual(toNumber('一百零五'), 105);
});

test('外语翻译括号：整句剥掉，(OS) 与中文括号保留', () => {
  assert.strictEqual(stripTranslations('药够了。(La dosis es suficiente.)'), '药够了。');
  assert.strictEqual(stripTranslations('夜 内 庄园（Noche. Int. Mansión）'), '夜 内 庄园');
  assert.strictEqual(stripTranslations('Elena(OS)：走'), 'Elena(OS)：走');
  assert.strictEqual(stripTranslations('Carla（冷静）：好'), 'Carla（冷静）：好');
});

test('分集：排除大纲条目，只认正文里的「第N集」', () => {
  const paras = [
    '分集',
    '第1集 开场', '本集：概述一', '第2集 升级', '本集：概述二',
    '正文内容',
    '第1集', '1-1 夜 内 庄园', '人物：甲 乙', '△甲走进门。', '甲：你好。',
    '第2集', '2-1 日 外 街道', '△乙跑。',
  ];
  const { episodes, issues } = analyzeParagraphs(paras);
  assert.deepStrictEqual(episodes.map((e) => [e.no, e.title]), [[1, '开场'], [2, '升级']]);
  assert.strictEqual(episodes[0].scenes, 1);
  assert.ok(episodes[0].words.full > episodes[0].words.pure);
  assert.strictEqual(issues.length, 0);
});

test('空集记 0 字；缺集与重复集号会提示', () => {
  const { episodes, issues } = analyzeParagraphs(['第1集', '△有内容。', '第2集', '-', '第4集', '△又有。', '第4集', '△重复。']);
  assert.strictEqual(episodes[1].words.full, 0);
  const text = issues.map((i) => i.text).join('|');
  assert.match(text, /缺集：第3集/);
  assert.match(text, /重复：第4集/);
});

test('文本文件、未识别分集、不支持的格式', () => {
  const r = analyzeBuffer(Buffer.from('第1集\n△你好。\n第2集\n△再见。\n'), 'a.txt');
  assert.strictEqual(r.episodes.length, 2);
  assert.strictEqual(analyzeBuffer(Buffer.from('没有标题'), 'b.md').episodes.length, 0);
  assert.throws(() => analyzeBuffer(Buffer.from('x'), 'c.pdf'), /不支持/);
  assert.throws(() => analyzeBuffer(Buffer.from('x'), 'd.docx'), /docx/);
});

test('中文主统计包含中文和半角标点，保留原 WPS 参考字段', () => {
  const r = analyzeParagraphs(['第1集 标题不参与统计', '你好，世界！ Hello 123']);
  assert.strictEqual(r.lang, 'zh');
  assert.deepStrictEqual(r.episodes[0].counts, { full: 7, clean: 7, pure: 7 });
  assert.deepStrictEqual(r.episodes[0].words, { full: 7, clean: 7, pure: 7 });
  for (const text of ['你好，世界！', '你好,世界!']) {
    const e = analyzeParagraphs(['第1集', text]).episodes[0];
    assert.deepStrictEqual(e.counts, { full: 6, clean: 6, pure: 6 });
    assert.strictEqual(e.words.full, text.includes('，') ? 6 : 4);
  }
  const punctuation = analyzeParagraphs(['第1集', '，。!?() 123']);
  assert.strictEqual(punctuation.lang, 'zh');
  assert.strictEqual(punctuation.episodes[0].counts.full, 6);
});

test('中文夹杂的英文单词各计 1 字，单字母词和词内标点不重复计数', () => {
  const cases = [
    ['Jack刚刚告诉我。', 7], // Jack + 刚刚告诉我（5）+ 句号
    ['Jack和Lily说：Hello, world!', 9], // 4 个词 + 2 个汉字 + 3 个标点
    ['甲说：I am a hero!', 8],
    ["甲说：don't well-known。", 6],
    ['甲说：“Jack”！', 7],
    ['甲说：Jack，Lily! 123\t　', 7],
  ];
  for (const [text, expected] of cases) {
    assert.strictEqual(countChineseDrama(text), expected, text);
    const result = analyzeParagraphs(['第1集', text]);
    assert.strictEqual(result.lang, 'zh');
    assert.deepStrictEqual(result.episodes[0].counts,
      { full: expected, clean: expected, pure: expected }, text);
  }
  assert.strictEqual(countChineseDrama(''), 0);
  assert.strictEqual(countChineseDrama('123\n\t　'), 0);
});

test('中文正文不会被长篇外语括号误判；纯台词统计排除场景与人物行', () => {
  const r = analyzeParagraphs([
    '第1集', '1-1 夜 内 家', '人物：甲',
    '甲：你好。（Hello there, this long translated sentence must not change the language.）',
  ]);
  assert.strictEqual(r.lang, 'zh');
  assert.deepStrictEqual(r.episodes[0].counts, { full: 28, clean: 13, pure: 5 });
  assert.ok(r.episodes[0].words.full > r.episodes[0].words.clean);
});

test('英文正文按单词统计，忽略中文标题与场景标签，保留英文括号动作', () => {
  const r = analyzeParagraphs([
    '第1集 中文集标题', '1-1 夜 内 ROOM', '人物：Alice',
    'Alice: Hello, world! (She opens the door.) 123 I a',
  ]);
  assert.strictEqual(r.lang, 'en');
  assert.deepStrictEqual(r.episodes[0].counts, { full: 9, clean: 9, pure: 7 });
  // 保留旧 words 合同：旧口径仍剥离外语括号，供既有调用方对照。
  assert.strictEqual(r.episodes[0].words.pure, 3);
});

test('空集和未识别分集仍返回稳定的语言与计数字段', () => {
  const r = analyzeParagraphs(['第1集', '第2集', '你好！']);
  assert.strictEqual(r.lang, 'zh');
  assert.deepStrictEqual(r.episodes[0].counts, { full: 0, clean: 0, pure: 0 });
  assert.strictEqual(analyzeParagraphs(['无分集标题']).lang, 'zh');
});
