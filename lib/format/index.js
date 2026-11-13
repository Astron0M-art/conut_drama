// 对外入口：上传 → 先格式校验 →（通过才）统计字数。校验与字数统计共用同一份「逻辑段落」。
'use strict';

const path = require('path');
const { readParagraphs } = require('./read');
const { check } = require('./check');
const { autoFix } = require('./fix');
const { exportDocx } = require('./export');
const { analyzeParagraphs } = require('../episodes');

function load(buf, filename) {
  const ext = path.extname(filename).toLowerCase();
  return { ext, name: path.basename(filename, ext), paras: readParagraphs(buf, ext) };
}

function slim(report) {
  return { ok: report.ok, errors: report.errors, warns: report.warns, fixable: report.fixable, issues: report.issues, blocks: report.blocks };
}

// 校验；通过则附带字数统计，不通过则不统计
function validateBuffer(buf, filename) {
  const { ext, name, paras } = load(buf, filename);
  const report = check(paras);
  const out = { name, ext, paras: undefined, format: slim(report) };
  out.paragraphs = paras;
  if (report.ok) out.analysis = analyzeParagraphs(paras);
  return out;
}

// 对（可能已被用户手改过的）段落重新校验；通过则统计
function validateParagraphs(paras, name = '') {
  const report = check(paras);
  return { name, paragraphs: paras, format: slim(report), ...(report.ok ? { analysis: analyzeParagraphs(paras) } : {}) };
}

function fixParagraphs(paras, name = '') {
  const r = autoFix(paras);
  return { ...validateParagraphs(r.paras, name), applied: r.applied };
}

module.exports = { validateBuffer, validateParagraphs, fixParagraphs, exportDocx, check, autoFix, readParagraphs };
