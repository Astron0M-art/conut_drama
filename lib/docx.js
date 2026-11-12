// 零依赖读取 .docx：只取 word/document.xml，按段落返回纯文本
'use strict';

const zlib = require('zlib');

const MAX_XML = 100 * 1024 * 1024; // 解压后上限，防 zip 炸弹

function readZipEntry(buf, wanted) {
  // 从末尾找 End Of Central Directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 .docx 文件（zip 结构损坏）');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === wanted) {
      const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const raw = buf.subarray(dataStart, dataStart + csize);
      if (method === 0) return raw;
      if (method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: MAX_XML });
      throw new Error('不支持的 docx 压缩方式');
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('docx 中找不到 word/document.xml');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function docxParagraphs(buf) {
  const xml = readZipEntry(buf, 'word/document.xml').toString('utf8');
  const out = [];
  const paraRe = /<w:p[ >][\s\S]*?<\/w:p>/g;
  const tokenRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/?>/g;
  for (const para of xml.match(paraRe) || []) {
    let text = '';
    let m;
    tokenRe.lastIndex = 0;
    while ((m = tokenRe.exec(para))) {
      if (m[1] !== undefined) text += decodeEntities(m[1]);
      else text += m[0].startsWith('<w:tab') ? '\t' : '\n';
    }
    // 软换行（&#10; 或 <w:br/>）拆成独立行，保证后面的「逐行」规则成立
    for (const line of text.split(/\r?\n/)) out.push(line.trim());
  }
  return out;
}

function textParagraphs(buf) {
  let s;
  try {
    s = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    s = new TextDecoder('gbk').decode(buf);
  }
  return s.replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim());
}

module.exports = { docxParagraphs, textParagraphs };
