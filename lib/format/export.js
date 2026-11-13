// 把（通过校验的）段落导出为与参考稿同款版式的 .docx：沿用参考稿的样式表/主题/页脚，只重写 document.xml
'use strict';
const fs = require('fs');
const path = require('path');
const zip = require('./zip');
const { check } = require('./check');

const REF = path.join(__dirname, 'reference.docx');
let template;
function getTemplate() { return template || (template = zip.readAll(fs.readFileSync(REF))); }

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const t = (s) => `<w:t xml:space="preserve">${esc(s).replace(/\n/g, '&#10;')}</w:t>`;
const run = (s, bold) => `<w:r>${bold ? '<w:rPr><w:b/><w:bCs/></w:rPr>' : ''}${t(s)}</w:r>`;
const P = (inner, ppr = '') => `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${inner}</w:p>`;
const EMPTY = '<w:p/>';

// 「标签：值」/ 「第N集：情节1…」这种前半加粗
function labeled(text) {
  const m = /^([^：\n]*：)([\s\S]*)$/.exec(text);
  return m ? run(m[1], true) + (m[2] ? run(m[2], false) : '') : run(text, false);
}

// 与参考稿一致的空段落位置：标题后 1 个；每个二级标题前 1 个；人物之间 1 个；粗纲后 2 个；场次之间/集标题前 1 个；文末 2 个
function bodyXml(blocks) {
  const x = [];
  let prevKind = '';
  let seenName = false;
  let firstH2 = true;
  let inBody = false;
  let sceneInEp = 0;
  let prevSection = '';
  for (const b of blocks) {
    const k = b.kind;
    if (k === 'title') { x.push(P(`<w:r><w:rPr><w:color w:val="000000"/></w:rPr>${t(b.text)}</w:r>`, '<w:pStyle w:val="2"/><w:jc w:val="center"/>')); continue; }
    if (k === 'h2') {
      if (prevSection === 'rough') x.push(EMPTY);
      x.push(EMPTY, P(run(b.text, false), '<w:pStyle w:val="3"/>'));
      prevSection = b.section; inBody = b.section === 'body'; firstH2 = false; seenName = false;
      continue;
    }
    if (k === 'pfield') { if (b.label === '姓名') { if (seenName) x.push(EMPTY); seenName = true; } x.push(P(labeled(b.text))); continue; }
    if (k === 'field') { x.push(P(labeled(b.text))); continue; }
    if (k === 'stage') { x.push(P(run(b.text, true))); continue; }
    if (k === 'jigang') { x.push(P(labeled(b.text))); continue; }
    if (k === 'ep') { if (sceneInEp || prevKind === 'action' || prevKind === 'dialog') x.push(EMPTY); x.push(P(run(b.text, true))); sceneInEp = 0; prevKind = k; continue; }
    if (k === 'scene') { if (sceneInEp) x.push(EMPTY); sceneInEp++; x.push(P(run(b.text, false))); prevKind = k; continue; }
    x.push(P(run(b.text, false)));
    prevKind = k;
  }
  void firstH2; void inBody;
  x.push(EMPTY, EMPTY);
  return x.join('');
}

function exportDocx(paras) {
  const rep = check(paras);
  const files = new Map(getTemplate());
  const doc = files.get('word/document.xml').toString('utf8');
  const head = doc.slice(0, doc.indexOf('<w:body>') + 8);
  const sect = doc.slice(doc.indexOf('<w:sectPr'));
  files.set('word/document.xml', Buffer.from(head + bodyXml(rep.blocks) + sect, 'utf8'));
  return zip.writeAll(files);
}

module.exports = { exportDocx, bodyXml };
