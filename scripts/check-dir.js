// 批量跑格式校验：node scripts/check-dir.js <文件或目录...>   输出每本剧本的错误摘要
'use strict';
const fs = require('fs');
const path = require('path');
const { readParagraphs } = require('../lib/format/read');
const { check } = require('../lib/format/check');

const files = [];
for (const a of process.argv.slice(2)) {
  const st = fs.statSync(a);
  if (st.isDirectory()) for (const f of fs.readdirSync(a)) /\.(docx|txt|md)$/i.test(f) && files.push(path.join(a, f));
  else files.push(a);
}
for (const f of files) {
  try {
    const r = check(readParagraphs(fs.readFileSync(f), path.extname(f).toLowerCase()));
    const by = {};
    for (const i of r.issues) by[i.code + (i.level === 'warn' ? '(警)' : '')] = (by[i.code + (i.level === 'warn' ? '(警)' : '')] || 0) + 1;
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${path.basename(f).slice(0, 44)}  错误${r.errors} 警告${r.warns} 可修${r.fixable}`);
    if (process.env.V) console.log('      ', JSON.stringify(by));
  } catch (e) { console.log('ERR   ', path.basename(f), e.message); }
}
