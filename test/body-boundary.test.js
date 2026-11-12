'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { analyzeParagraphs } = require('../lib/episodes');
const { analyzeBuffer } = require('../lib/analyze');

// 合成 ZIP 夹具，不包含用户上传的真实剧本。
function zip(entries) {
  const locals = [], central = [];
  let offset = 0;
  const crc32 = (bytes) => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  for (const [name, text] of entries) {
    const filename = Buffer.from(name), data = Buffer.from(text);
    const compressed = zlib.deflateRawSync(data), crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    locals.push(local, filename, compressed);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(compressed.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(filename.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test('锁定剧本正文，前面的分集大纲不依赖“本集”措辞也不会参与计数', () => {
  const result = analyzeParagraphs([
    '分集大纲', '第1集 大纲标题', '这是一段没有本集标签的大纲。',
    '第2集 另一段大纲', '2-1 日 内 大纲场景', '大纲内容不能统计。',
    '剧本正文', '第1集', '甲：Jack来了。',
  ]);
  assert.deepEqual(result.episodes.map((episode) => episode.no), [1]);
  assert.deepEqual(result.episodes[0].counts, { full: 6, clean: 6, pure: 6 });
  assert.equal(result.episodes[0].paragraphs, 1);
  assert.equal(result.episodes[0].scenes, 0);
  assert.equal(result.issues.some((issue) => issue.type === 'dup'), false);
});

test('只有分集大纲而没有剧本正文时返回空结果并提示正文缺失', () => {
  const result = analyzeParagraphs([
    '分集大纲', '第1集 开场', '这段只是梗概。', '第2集 升级', '2-1 日 内 房间', '这仍是大纲。',
  ]);
  assert.deepEqual(result.episodes, []);
  assert.ok(result.issues.some((issue) => /正文/.test(issue.text)));
});

test('找到剧本正文但未找到集或场次时，不回退统计前面的大纲', () => {
  const result = analyzeParagraphs([
    '分集大纲', '第1集 大纲内容', '甲：这一段也不算。',
    '剧本正文', '正文尚待补充',
  ]);
  assert.deepEqual(result.episodes, []);
  assert.ok(result.issues.length > 0);
});

test('显式集标题与场次编号混用：同集不重复，缺标题的3-1和3-2归入第3集', () => {
  const result = analyzeParagraphs([
    '分集大纲', '第2集 只有大纲', '本集：没有正文。', '第41集 只有大纲', '本集：没有正文。',
    '剧本正文', '第1集', '1-1 日 内 房间', '人物：甲', '甲：Jack来了。',
    '3-1 日 外 街道', '人物：乙', '乙：Hello！', '3-2 夜 内 家', '乙：再见。',
  ]);
  assert.deepEqual(result.episodes.map((episode) => episode.no), [1, 3]);
  assert.deepEqual(result.episodes.map((episode) => episode.scenes), [1, 2]);
  assert.deepEqual(result.episodes.map((episode) => episode.paragraphs), [3, 5]);
  assert.deepEqual(result.episodes.map((episode) => episode.counts), [
    { full: 15, clean: 15, pure: 6 },
    { full: 22, clean: 22, pure: 9 },
  ]);
  assert.ok(result.issues.some((issue) => issue.type === 'gap' && /第2集/.test(issue.text)));
  assert.equal(result.issues.some((issue) => issue.type === 'dup'), false);
});

test('裸场次编号也能分集，首场标题计入full且不计入pure', () => {
  const result = analyzeParagraphs(['剧本正文', '3-1', '甲：你好。', '3-2', '乙：再见。', '4-1', '甲：走。']);
  assert.deepEqual(result.episodes.map((episode) => episode.no), [3, 4]);
  assert.deepEqual(result.episodes.map((episode) => episode.scenes), [2, 1]);
  assert.deepEqual(result.episodes.map((episode) => episode.counts), [
    { full: 12, clean: 12, pure: 10 },
    { full: 5, clean: 5, pure: 4 },
  ]);
});

test('正文标题兼容空格和Markdown装饰，排除装饰标题之前的内容', () => {
  for (const marker of ['剧 本 正 文', '# **剧本正文**', '## 正文内容', '正文']) {
    const result = analyzeBuffer(Buffer.from([
      '分集大纲', '第9集 大纲', '这段大纲不算。', marker,
      '第1集', '甲：Jack来了。',
    ].join('\n')), 'synthetic.md');
    assert.deepEqual(result.episodes.map((episode) => episode.no), [1], marker);
    assert.equal(result.episodes[0].counts.full, 6, marker);
  }
});

test('没有总标题的纯正文仍按独立集标题正常统计，台词内场次字样不会拆集', () => {
  const result = analyzeParagraphs(['第1集', '甲：看看3-1房间。', '第2集', 'Jack来了。']);
  assert.deepEqual(result.episodes.map((episode) => episode.no), [1, 2]);
  assert.deepEqual(result.episodes.map((episode) => episode.scenes), [0, 0]);
  assert.deepEqual(result.episodes.map((episode) => episode.counts.full), [8, 4]);
});

test('合成DOCX中标题样式、灰底、多run、表格和软换行不改变正文边界与分集', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
  <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
    <w:p><w:r><w:t>分集大纲</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Heading2"/><w:shd w:fill="EEEEEE"/></w:pPr><w:r><w:t>第1集 大纲</w:t></w:r></w:p>
    <w:p><w:r><w:t>这里不是正文，不能计数。</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>剧本</w:t></w:r><w:r><w:t>正文</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>第</w:t></w:r><w:r><w:t>1</w:t></w:r><w:r><w:t>集</w:t></w:r></w:p>
    <w:p><w:pPr><w:shd w:fill="EEEEEE"/></w:pPr><w:r><w:t>1-1 日 内 房间</w:t></w:r></w:p>
    <w:p><w:r><w:t>甲：你好。</w:t><w:br/><w:t>Jack来了。</w:t></w:r></w:p>
    <w:tbl><w:tr><w:tc>
      <w:p><w:pPr><w:shd w:fill="EEEEEE"/></w:pPr><w:r><w:t>3-1 日 外 街道</w:t></w:r></w:p>
      <w:p><w:r><w:t>乙：再见。</w:t></w:r></w:p>
    </w:tc></w:tr></w:tbl>
  </w:body></w:document>`;
  const contentTypes = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
  const relationships = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
  const result = analyzeBuffer(zip([
    ['[Content_Types].xml', contentTypes], ['_rels/.rels', relationships], ['word/document.xml', xml],
  ]), 'synthetic-layout.docx');
  assert.deepEqual(result.episodes.map((episode) => episode.no), [1, 3]);
  assert.deepEqual(result.episodes.map((episode) => episode.paragraphs), [3, 2]);
  assert.deepEqual(result.episodes.map((episode) => episode.scenes), [1, 1]);
  assert.deepEqual(result.episodes.map((episode) => episode.counts), [
    { full: 14, clean: 14, pure: 9 },
    { full: 10, clean: 10, pure: 5 },
  ]);
});
