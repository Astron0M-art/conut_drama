// 文件 → 逐集字数（不含格式校验；校验与统计的完整链路见 lib/format/index.js）
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
  return { name: path.basename(filename, ext), ext, ...analyzeParagraphs(paras) };
}

module.exports = { analyzeBuffer };
