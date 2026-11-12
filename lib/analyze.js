// 对外入口：Buffer + 文件名 → 分析结果
'use strict';

const path = require('path');
const { docxParagraphs, textParagraphs } = require('./docx');
const { analyzeParagraphs } = require('./episodes');

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

module.exports = { analyzeBuffer };
