// 自动修复：每轮应用每个段落上的第一个可修复问题，然后重新校验，直到不再变化（最多 8 轮）
'use strict';

const { check } = require('./check');

function addInterval(map, para, start, end) {
  if (end <= start) return;
  if (!map.has(para)) map.set(para, []);
  map.get(para).push([start, end]);
}

function mergedIntervals(intervals) {
  const sorted = intervals.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [start, end] of sorted) {
    const prev = out[out.length - 1];
    if (prev && start <= prev[1]) prev[1] = Math.max(prev[1], end);
    else out.push([start, end]);
  }
  return out;
}

function removeIntervals(text, intervals) {
  let out = '';
  let pos = 0;
  for (const [start, end] of mergedIntervals(intervals)) {
    out += text.slice(pos, start);
    pos = end;
  }
  return out + text.slice(pos);
}

function applyOnce(paras, issues) {
  const byPara = new Map();
  const angleRanges = [];
  for (const it of issues) {
    if (!it.fixable || it.para == null) continue;
    if (it.fix?.op === 'removeAngle') {
      angleRanges.push({ para: it.para, ...it.fix });
      continue;
    }
    if (!byPara.has(it.para)) byPara.set(it.para, it);
  }

  // 先把所有尖括号块转换成逐段删除区间；这样同一段多个标签、跨段落标签都能一次处理。
  const intervals = new Map();
  const dropParas = new Set();
  for (const range of angleRanges) {
    const startPara = Number.isInteger(range.startPara) ? range.startPara : range.para;
    const endPara = Number.isInteger(range.endPara) ? range.endPara : startPara;
    const start = Math.max(0, range.startIndex || 0);
    const end = Math.max(start, range.endIndex || start);
    if (startPara === endPara) addInterval(intervals, startPara, start, end);
    else {
      addInterval(intervals, startPara, start, String(paras[startPara] || '').length);
      addInterval(intervals, endPara, 0, end);
      for (let i = startPara + 1; i < endPara; i++) dropParas.add(i);
    }
  }

  const out = [];
  let changed = 0;
  paras.forEach((t, i) => {
    if (dropParas.has(i)) { changed++; return; }
    if (intervals.has(i)) {
      const next = removeIntervals(String(t), intervals.get(i));
      if (next !== t) changed++;
      if (next) out.push(next);
      return;
    }
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
    // 先清掉模型标签块，再处理其余格式问题；否则标签块里的“第99集/99-2”
    // 会先污染集号状态，自动修复可能把真实正文场次改成错误集号。
    const angleIssues = r.issues.filter((it) => it.code === 'model-output-angle-tag');
    const next = applyOnce(cur, angleIssues.length ? angleIssues : r.issues);
    if (!next.changed) break;
    cur = next.paras;
    applied += next.changed;
  }
  return { paras: cur, applied, rounds, report: check(cur) };
}

// 批量清理模型残留时只删除正文尖括号块，避免顺手改动集号、场次头等人工格式。
function autoFixAngleTags(paras, maxRounds = 8) {
  let cur = paras.slice(); let applied = 0; let rounds = 0;
  for (; rounds < maxRounds; rounds++) {
    const r = check(cur);
    const angleIssues = r.issues.filter((it) => it.code === 'model-output-angle-tag');
    const next = applyOnce(cur, angleIssues);
    if (!next.changed) break;
    cur = next.paras; applied += next.changed;
  }
  return { paras: cur, applied, rounds, report: check(cur) };
}

module.exports = { autoFix, autoFixAngleTags, applyOnce };
