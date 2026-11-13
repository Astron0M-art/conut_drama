// 读取为「逻辑段落」数组：去空段，Word 软换行保留为 \n，并把被拆开的「情节N」「行动线子项」并回上一段
'use strict';

const { readZipEntry, decodeEntities } = require('../docx');

const clean = (s) => s.replace(/[​-‍﻿]/g, '').replace(/ /g, ' ');

function docxRaw(buf) {
  const xml = readZipEntry(buf, 'word/document.xml').toString('utf8');
  const out = [];
  const tokenRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/?>/g;
  for (const para of xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || []) {
    let text = '';
    let m;
    tokenRe.lastIndex = 0;
    while ((m = tokenRe.exec(para))) {
      if (m[1] !== undefined) text += decodeEntities(m[1]);
      else text += m[0].startsWith('<w:tab') ? ' ' : '\n';
    }
    out.push(text);
  }
  return out;
}

function textRaw(buf) {
  let s;
  try { s = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { s = new TextDecoder('gbk').decode(buf); }
  return s.replace(/^﻿/, '').split(/\r?\n/);
}

const PLOT = /^情节\d+[：:]/;
const OUTLINE_HEAD = /^第\s*[0-9０-９]+\s*集[：:]/;
const ACTION_PART = /^(起点|目标|关键选择|代价|变化)[：:]/;

function toParagraphs(raw) {
  const out = [];
  let inActionLine = false;
  for (const r of raw) {
    const lines = clean(r).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    for (const line of lines) {
      const prev = out[out.length - 1];
      if (prev !== undefined && PLOT.test(line) && (OUTLINE_HEAD.test(prev) || /(^|\n)情节\d+[：:]/.test(prev))) {
        out[out.length - 1] = `${prev}\n${line}`;
      } else if (prev !== undefined && ACTION_PART.test(line) && inActionLine) {
        out[out.length - 1] = `${prev}\n${line}`;
      } else {
        out.push(line);
      }
      inActionLine = /^人物行动线[：:]/.test(out[out.length - 1]);
    }
  }
  return out;
}

function readParagraphs(buf, ext) {
  if (ext === '.docx') return toParagraphs(docxRaw(buf));
  if (ext === '.txt' || ext === '.md') return toParagraphs(textRaw(buf));
  if (ext === '.doc') throw new Error('不支持旧版 .doc，请在 WPS/Word 里另存为 .docx');
  throw new Error(`不支持的文件类型 ${ext || '(无扩展名)'}，请上传 .docx / .txt / .md`);
}

module.exports = { readParagraphs, toParagraphs };
