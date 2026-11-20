'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { exportAuditXlsx } = require('../lib/audit-export');
const { readAll } = require('../lib/format/zip');

const options = { min: 550, max: 1000, incScene: false, incCast: true };
const decode = (value) => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function readWorkbook(books, customOptions = options) {
  const buffer = exportAuditXlsx({ options: customOptions, books, totals: {} });
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.subarray(0, 2).toString(), 'PK');
  const files = readAll(buffer);
  const sheet = files.get('xl/worksheets/sheet1.xml').toString('utf8');
  const rows = [...sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((row) => (
    [...row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((cell) => {
      const text = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(cell[2] || '');
      const number = /<v>([^<]*)<\/v>/.exec(cell[2] || '');
      return text ? decode(text[1]) : number ? Number(number[1]) : null;
    })
  ));
  return { files, sheet, rows };
}

function book(name, extra = {}) {
  return {
    id: name, name, status: 'done', label: '全部合格', totalEpisodes: 2,
    totalWords: 1400, qualifiedEpisodes: 2, badEpisodes: [], issues: [], passed: true, unit: '字',
    ...extra,
  };
}

test('真实 XLSX 固定四列，100 本剧本名称都出现在审核统计中', () => {
  const books = Array.from({ length: 100 }, (_, i) => book(`第${i + 1}本测试剧本`));
  const { files, sheet, rows } = readWorkbook(books);
  assert.deepEqual(rows[0], ['剧本名称', '剧本总集数', '超标集', '超标集字数']);
  assert.equal(rows.length, 101);
  assert.ok(rows.every((row) => row.length === 4));
  assert.deepEqual(rows.slice(1).map((row) => row[0]), books.map((item) => item.name));
  assert.ok(rows.slice(1).every((row) => row[1] === 2 && row[2] === '全部合格' && row[3] === ''));
  assert.match(sheet, /<autoFilter ref="A1:D101"\/>/);
  assert.match(sheet, /ySplit="1"[^>]*state="frozen"/);
  assert.match(sheet, /<col min="1" max="1" width="48" customWidth="1"\/>/);
  assert.match(files.get('xl/workbook.xml').toString(), /name="审核统计"/);
  assert.match(files.get('xl/workbook.xml').toString(), /name="统计口径"/);
  for (const entry of ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'docProps/core.xml']) {
    assert.ok(files.has(entry), `${entry} 必须存在于可读 ZIP 中`);
  }
  assert.match(files.get('xl/styles.xml').toString(), /<font><b\/>/);
  assert.match(files.get('xl/_rels/workbook.xml.rels').toString(), /Target="worksheets\/sheet2.xml"/);
});

test('同一剧本的不足、超限、空集合并一行，集号与字数顺序对应', () => {
  const { rows } = readWorkbook([book('异常剧本', {
    passed: false, label: '需调整3集', totalEpisodes: 8,
    badEpisodes: [
      { no: 2, n: 500, kind: 'short', label: '字数不足', diff: 50 },
      { no: 6, n: 1024, kind: 'long', label: '超过上限', diff: 24 },
      { no: 8, n: 0, kind: 'empty', label: '空集', diff: 550 },
    ],
  })]);
  assert.deepEqual(rows.slice(1), [[
    '异常剧本', 8,
    '第2集（字数不足）；第6集（超过上限）；第8集（空集）',
    '500、1024、0',
  ]]);
});

test('等待、处理中、格式失败和读取失败均保留，未知总集数留空', () => {
  const states = [
    ['排队剧本', 'queued', '排队中'],
    ['处理剧本', 'running', '正在校验'],
    ['重算剧本', 'rechecking', '修改后待重算'],
    ['格式失败剧本', 'format_error', '格式未通过'],
    ['读取失败剧本', 'error', '处理失败'],
    ['未识别剧本', 'no_episodes', '未识别到正文集数'],
  ];
  const { rows, sheet } = readWorkbook(states.map(([name, status, label]) => book(name, {
    status, label, totalEpisodes: null, totalWords: null, qualifiedEpisodes: null, passed: null,
  })));
  assert.deepEqual(rows.slice(1), states.map(([name, , label]) => [name, null, label, '']));
  assert.doesNotMatch(sheet, /<c r="B[2-7]"[^>]*><v>0<\/v>/);
  assert.doesNotMatch(sheet, />全部合格</);
});

test('缺集、重复等识别问题以附加状态行展示，不误报整本合格', () => {
  const { rows } = readWorkbook([
    book('缺集剧本', {
      passed: false, label: '字数合格，需核对集数',
      issues: [{ type: 'missing', text: '缺少第2集' }, { type: 'duplicate', text: '第3集重复' }],
    }),
    book('矛盾状态仍需核对', { issues: [{ type: 'missing', text: '缺少第4集' }] }),
  ]);
  assert.deepEqual(rows.slice(1), [
    ['缺集剧本', 2, '字数合格，需核对集数；识别提示：缺少第2集；识别提示：第3集重复', ''],
    ['矛盾状态仍需核对', 2, '字数合格（存在识别提示）；识别提示：缺少第4集', ''],
  ]);
});

test('剧本名和提示转义 XML，公式样式名称作为文本保存', () => {
  const names = ['=HYPERLINK("https://example.test","打开")', '+SUM(1,2)', '-1+2', '@SUM(A1:A2)', 'A&B<剧本>"引号\' 😀'];
  const { rows, sheet } = readWorkbook(names.map((name) => book(name, {
    issues: [{ type: 'warning', text: 'A&B <需核对> "双引号"' }],
  })));
  assert.deepEqual(rows.slice(1).map((row) => row[0]), names);
  assert.match(sheet, /A&amp;B&lt;剧本&gt;&quot;引号&apos; 😀/);
  assert.match(sheet, /&lt;需核对&gt;/);
  assert.doesNotMatch(sheet, /<f(?:\s|>)/);
  assert.match(sheet, /r="A2" s="0" t="inlineStr"><is><t xml:space="preserve">=HYPERLINK/);
  const sanitized = readWorkbook([book('控制\u0000字符\ud800')]).rows;
  assert.equal(sanitized[1][0], '控制字符');
});

test('统计口径记录阈值、场次与人物选项、单位和生成时间', () => {
  const { files } = readWorkbook([book('英文稿', { unit: '词' })]);
  const rules = files.get('xl/worksheets/sheet2.xml').toString('utf8');
  assert.match(rules, /生成时间（UTC）/);
  assert.match(rules, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  assert.match(rules, /<c r="B3" s="2" t="n"><v>550<\/v><\/c>/);
  assert.match(rules, /<c r="B4" s="2" t="n"><v>1000<\/v><\/c>/);
  assert.match(rules, /<c r="B5"[^>]*><is><t[^>]*>否<\/t>/);
  assert.match(rules, /<c r="B6"[^>]*><is><t[^>]*>是<\/t>/);
  assert.match(rules, /剧本单位：英文稿/);
  assert.match(rules, /<c r="B10"[^>]*><is><t[^>]*>词<\/t>/);
});
