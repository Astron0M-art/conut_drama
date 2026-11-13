// 自动修复：每轮应用每个段落上的第一个可修复问题，然后重新校验，直到不再变化（最多 8 轮）
'use strict';

const { check } = require('./check');

function applyOnce(paras, issues) {
  const byPara = new Map();
  for (const it of issues) {
    if (!it.fixable || it.para == null) continue;
    if (!byPara.has(it.para)) byPara.set(it.para, it);
  }
  const out = [];
  let changed = 0;
  paras.forEach((t, i) => {
    const it = byPara.get(i);
    if (!it) return out.push(t);
    const f = it.fix;
    changed++;
    if (f.op === 'set') out.push(f.text);
    else if (f.op === 'insertBefore') { out.push(f.text); out.push(t); }
    else if (f.op === 'delete') { /* 丢弃 */ } else { out.push(t); changed--; }
  });
  return { paras: out, changed };
}

function autoFix(paras, maxRounds = 8) {
  let cur = paras.slice();
  let applied = 0;
  let rounds = 0;
  for (; rounds < maxRounds; rounds++) {
    const r = check(cur);
    const next = applyOnce(cur, r.issues);
    if (!next.changed) break;
    cur = next.paras;
    applied += next.changed;
  }
  return { paras: cur, applied, rounds, report: check(cur) };
}

module.exports = { autoFix, applyOnce };
