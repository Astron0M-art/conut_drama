// 对外入口：Buffer + 文件名 → 分析结果
'use strict';

const path = require('path');
const { docxParagraphs, textParagraphs } = require('./docx');
const { analyzeParagraphs } = require('./episodes');
const { readParagraphs } = require('./format/read');
const { check } = require('./format/check');

function analyzeBuffer(buf, filename) {
  const ext = path.extname(filename).toLowerCase();
  let paras;
  if (ext === '.docx') paras = docxParagraphs(buf);
  else if (ext === '.txt' || ext === '.md') paras = textParagraphs(buf);
  else if (ext === '.doc') throw new Error('不支持旧版 .doc，请在 WPS/Word 里另存为 .docx');
  else throw new Error(`不支持的文件类型 ${ext || '(无扩展名)'}，请上传 .docx / .txt / .md`);

  const result = analyzeParagraphs(paras);
  return { name: path.basename(filename, ext), ext, ...result };
}

// 带格式门控的分析链路：不通过则不统计，返回格式报错
function analyzeWithFormat(buf, filename) {
  const ext = path.extname(filename).toLowerCase();
  const report = check(readParagraphs(buf, ext));
  if (!report.ok) {
    const top = report.issues.filter((i) => i.level === 'error').slice(0, 5).map((i) => ({ para: i.para, code: i.code, message: i.message }));
    return { name: path.basename(filename, ext), ext, formatFailed: true, errors: report.errors, fixable: report.fixable, top };
  }
  return analyzeBuffer(buf, filename);
}

module.exports = { analyzeBuffer, analyzeWithFormat };
