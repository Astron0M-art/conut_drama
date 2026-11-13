'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => n.toLocaleString('zh-CN');
const MAX_BOOKS = 20;
const CONCURRENCY = 20;
const EXTS = ['.docx', '.txt', '.md'];
// S 是「当前选中那一本」的视图；books 保存每本的状态
const S = { name: '', paras: [], res: null, editing: -1, onlyBad: false, min: 550, max: 1000, caliber: 'full', busy: false };
const books = []; let cur = null; let seq = 0;

function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 3000); }

async function call(url, opts) {
  const r = await fetch(url, opts);
  if (r.status === 401) { location.href = '/login?expired=1'; throw new Error('登录已过期'); }
  if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || `服务器返回 ${r.status}`); }
  return r;
}
const postJSON = (url, body) => call(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function select(b) {
  if (cur) { cur.paras = S.paras; cur.res = S.res; cur.onlyBad = S.onlyBad; }
  cur = b;
  S.name = b.name; S.paras = b.paras || []; S.res = b.res || null; S.editing = -1; S.onlyBad = !!b.onlyBad;
  renderTabs();
  if (b.status === 'done' && S.res) render(); else { $('stage').hidden = true; $('steps').hidden = true; }
}

function renderTabs() {
  $('tabs').hidden = books.length === 0;
  const label = { queued: ['排队', 'run'], running: ['校验中', 'run'], error: ['失败', 'bad'] };
  $('tabs').innerHTML = (books.length > 1 ? `<span class="chip" style="align-self:center">共 ${books.length} 本 · 通过 <b>${books.filter((b) => b.res && b.res.format.ok).length}</b> · 待处理 <b>${books.filter((b) => b.status === 'done' && !b.res.format.ok).length}</b></span>` : '') + books.map((b) => {
    const st = b.status === 'done' ? (b.res.format.ok ? ['通过', 'ok'] : [`${b.res.format.errors} 错`, 'bad']) : label[b.status];
    return `<div class="tab ${b === cur ? 'cur' : ''}" data-a="tab" data-id="${b.id}" title="${esc(b.file.name)}"><span class="nm">${esc(b.name)}</span><span class="st ${st[1]}">${st[0]}</span><button class="x" data-a="rm" data-id="${b.id}" title="移除">×</button></div>`;
  }).join('');
}

let running = 0;
function pump() {
  while (running < CONCURRENCY) {
    const b = books.find((x) => x.status === 'queued');
    if (!b) return;
    b.status = 'running'; running++;
    validateOne(b).finally(() => { running--; pump(); });
  }
}

async function validateOne(b) {
  renderTabs();
  try {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch('/api/validate', { method: 'POST', headers: { 'X-Filename': encodeURIComponent(b.file.name), 'Content-Type': 'application/octet-stream' }, body: b.file });
      if (r.status === 503 && attempt < 5) { await new Promise((x) => setTimeout(x, 700 * (attempt + 1))); continue; }
      if (r.status === 401) { location.href = '/login?expired=1'; throw new Error('登录已过期'); }
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `服务器返回 ${r.status}`);
      b.name = d.name; b.paras = d.paragraphs; b.res = d; b.status = 'done';
      break;
    }
  } catch (e) { b.status = 'error'; b.error = e.message === 'Failed to fetch' ? '无法连接服务器' : e.message; }
  if (!cur) select(b); else if (b === cur) select(b); else renderTabs();
  if (b === cur && b.status === 'done' && b.res.format.ok) setTimeout(() => $('count').scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
  if (b === cur && b.status === 'error') toast(`《${b.name}》${b.error}`);
}

function addFiles(list) {
  $('hint').hidden = true;
  let skipped = 0; let over = 0; let dup = 0;
  for (const f of [...list]) {
    const ext = (f.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
    if (!EXTS.includes(ext)) { skipped++; continue; }
    if (books.some((b) => b.file.name === f.name && b.file.size === f.size)) { dup++; continue; }
    if (books.length >= MAX_BOOKS) { over++; continue; }
    books.push({ id: ++seq, file: f, name: f.name.replace(/\.[^.]+$/, ''), status: 'queued' });
  }
  const notes = [];
  if (over) notes.push(`最多同时 ${MAX_BOOKS} 本，已忽略 ${over} 个`);
  if (skipped) notes.push(`${skipped} 个文件格式不支持`);
  if (dup) notes.push(`${dup} 个文件已在列表中`);
  if (notes.length) toast(notes.join('；'));
  renderTabs(); pump();
  if (!cur && books.length) { /* 第一本校验完成后自动选中 */ }
}

async function recheck() {
  const d = await (await postJSON('/api/recheck', { name: S.name, paragraphs: S.paras })).json();
  S.res = d; S.editing = -1; if (cur) { cur.res = d; cur.paras = S.paras; } render(); renderTabs();
}
async function autofix() {
  const d = await (await postJSON('/api/fix', { name: S.name, paragraphs: S.paras })).json();
  S.paras = d.paragraphs; S.res = d; S.editing = -1; if (cur) { cur.res = d; cur.paras = d.paragraphs; } render(); renderTabs();
  toast(`已自动修复 ${d.applied} 处${d.format.ok ? '，格式通过，已进入字数统计' : `，还剩 ${d.format.errors} 个错误需手动处理`}`);
}
async function download() {
  try {
    const r = await postJSON('/api/export', { name: S.name, paragraphs: S.paras });
    const a = document.createElement('a'); a.href = URL.createObjectURL(await r.blob()); a.download = `${S.name}_标准格式.docx`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (e) { toast(e.message); }
}

/* ---------- 渲染 ---------- */
function paraHTML(b) {
  const issues = b.issues.map((id) => S.res.format.issues.find((x) => x.id === id)).filter(Boolean);
  const hasErr = issues.some((x) => x.level === 'error');
  const cls = ['p', b.kind, b.kind === 'title' ? 'title' : '', b.kind === 'h2' ? 'h2' : '', issues.length ? (hasErr ? 'bad' : 'warnrow') : ''].join(' ');
  let inner;
  if (S.editing === b.para) {
    return `<div class="${cls}" id="p${b.para}"><textarea id="ta" rows="${Math.min(8, b.text.split('\n').length + 1)}">${esc(b.text)}</textarea>
      <div class="rowact"><button data-a="save" data-i="${b.para}">保存</button><button data-a="cancel">取消</button><button data-a="del" data-i="${b.para}">删除本行</button><button data-a="addafter" data-i="${b.para}">下方新增一行</button></div></div>`;
  }
  const m = /^([^：\n]*：)([\s\S]*)$/.exec(b.text);
  if (['field', 'pfield', 'jigang'].includes(b.kind) && m) inner = `<b>${esc(m[1])}</b>${esc(m[2])}`;
  else if (['stage', 'ep'].includes(b.kind)) inner = `<b>${esc(b.text)}</b>`;
  else inner = esc(b.text);
  const why = issues.map((x) => `<span class="why ${x.level === 'warn' ? 'w' : ''}">${x.level === 'warn' ? '⚠' : '✗'} ${esc(x.message)}${x.fixable ? `<button data-a="fix" data-id="${x.id}">${x.fix.op === 'delete' ? '删除此行' : x.fix.op === 'insertBefore' ? `补上「${esc(x.fix.text)}」` : '一键改为：' + esc(x.fix.text.slice(0, 40)).replace(/\n/g, ' ')}</button>` : ''}</span>`).join('');
  return `<div class="${cls}" id="p${b.para}" data-i="${b.para}" title="点击修改本行"><span class="gutter">${b.para + 1}</span>${inner}${why}</div>`;
}

// 空行位置与导出的标准 docx 保持一致
function paperHTML() {
  const blocks = S.res.format.blocks;
  const out = [];
  const sp = '<div class="sp"></div>';
  let prevSection = ''; let seenName = false; let sceneInEp = 0; let prevKind = '';
  let lastShown = -2;
  const show = (b) => !S.onlyBad || b.issues.length;
  for (const b of blocks) {
    const k = b.kind;
    const keep = show(b) || (S.onlyBad && (k === 'h2' || k === 'title'));
    if (S.onlyBad) {
      if (!keep) { continue; }
      if (lastShown !== -2 && b.para - lastShown > 1) out.push(`<div class="folded">… 省略 ${b.para - lastShown - 1} 行 …</div>`);
      lastShown = b.para; out.push(paraHTML(b)); continue;
    }
    if (k === 'h2') { if (prevSection === 'rough') out.push(sp); out.push(sp); prevSection = b.section; seenName = false; }
    else if (k === 'pfield' && b.label === '姓名') { if (seenName) out.push(sp); seenName = true; }
    else if (k === 'ep') { if (sceneInEp || prevKind === 'action' || prevKind === 'dialog') out.push(sp); sceneInEp = 0; }
    else if (k === 'scene') { if (sceneInEp) out.push(sp); sceneInEp++; }
    prevKind = k;
    out.push(paraHTML(b));
  }
  return out.join('');
}

function render() {
  const r = S.res; if (!r) return;
  const f = r.format;
  $('stage').hidden = false;
  const paraIssues = f.issues.filter((x) => x.para != null);
  const global = f.issues.filter((x) => x.para == null);
  $('statusbar').className = `statusbar ${f.ok ? 'pass' : 'fail'}`;
  $('statusbar').innerHTML = `<div class="t">${f.ok ? '✓ 格式通过' : '✗ 格式未通过，暂不统计字数'}<small>《${esc(S.name)}》 · ${S.paras.length} 段 · 错误 ${f.errors} · 提示 ${f.warns}</small></div>
    <label class="chk"><input type="checkbox" id="onlyBad" ${S.onlyBad ? 'checked' : ''}>只看有问题的行</label>
    ${f.fixable ? `<button class="btn" data-a="autofix">一键自动修复（${f.fixable}）</button>` : ''}
    <button class="btn ghost" data-a="recheck">重新校验</button>
    <button class="btn ${f.ok ? '' : 'ghost'}" data-a="download" ${f.ok ? '' : 'disabled title="格式通过后才能导出标准 docx"'}>下载标准格式 docx</button>`;
  const list = (arr) => arr.map((x) => `<button class="issue ${x.level}" data-a="goto" data-p="${x.para ?? ''}"><span class="lv">${x.level === 'error' ? '错误' : '提示'}</span>${esc(x.message)}${x.fixable ? '<span class="fx">可自动修复</span>' : ''}${x.para != null ? `<div class="ln">第 ${x.para + 1} 行：${esc((S.paras[x.para] || '').slice(0, 30))}</div>` : ''}</button>`).join('');
  const cap = 200;
  $('side').innerHTML = `<h3>问题清单（${f.issues.length}）</h3>${f.ok && !f.issues.length ? '<p class="empty-hint" style="padding:12px 0">没有问题。</p>' : ''}${list(global)}${list(paraIssues.slice(0, cap))}${paraIssues.length > cap ? `<p class="ln">仅显示前 ${cap} 条，其余请在右侧文档中查看。</p>` : ''}`;
  $('paper').innerHTML = paperHTML();
  renderCount();
  buildMinimap();
}

function verdict(n) {
  if (n === 0) return { kind: 'empty', label: '空集', diff: 0 };
  if (n < S.min) return { kind: 'short', label: '偏少', diff: S.min - n };
  if (n > S.max) return { kind: 'long', label: '超长', diff: n - S.max };
  return { kind: 'ok', label: '合格', diff: 0 };
}

function chartHTML(eps, unit) {
  const top = Math.min(S.max * 1.6, Math.max(S.max * 1.25, ...eps.map((e) => e.n)) * 1.05);
  const pct = (n) => Math.min(100, (n / top) * 100);
  const cols = eps.map((e) => {
    const bad = e.v.kind !== 'ok'; const clip = e.n > top;
    const tip = `第${e.no}集 · ${fmt(e.n)} ${unit}` + (bad ? `（${e.v.label}${e.v.diff ? ' ' + fmt(e.v.diff) + ' ' + unit : ''}）` : '');
    return `<div class="col ${bad ? 'bad' : ''} ${e.v.kind === 'empty' ? 'empty' : ''} ${clip ? 'clip' : ''}" title="${esc(tip)}">${clip ? `<b class="clipn">${fmt(e.n)}</b>` : ''}<i style="height:${pct(e.n)}%"></i></div>`;
  }).join('');
  const plotW = Math.max(120, $('count').clientWidth - 2 * (innerWidth <= 720 ? 14 : 20) - (innerWidth <= 720 ? 34 : 40) - 2);
  const colW = Math.min(56, (plotW - (eps.length - 1) * 3) / eps.length) + 3;
  const step = Math.max(1, Math.ceil((String(Math.max(...eps.map((e) => e.no))).length * 7 + 14) / colW));
  const axis = eps.map((e, i) => `<span class="${e.v.kind !== 'ok' ? 'bad' : ''}">${i % step === 0 || (e.v.kind !== 'ok' && step <= 2) ? e.no : ''}</span>`).join('');
  return `<div class="chart"><div class="plot">${cols}<div class="band" style="bottom:${pct(S.min)}%;height:${pct(S.max) - pct(S.min)}%"><span class="hi">${S.max}</span><span class="lo">${S.min}</span></div></div><div class="axis">${axis}</div></div>`;
}

function setSteps() {
  const ok = S.res && S.res.format.ok;
  $('steps').hidden = !S.res;
  $('st1').className = ok ? 'done' : 'fail';
  $('st2').className = ok ? 'cur' : '';
}

function renderCount() {
  setSteps();
  $('ruleText').textContent = `${S.min}–${S.max}`;
  const el = $('count'); const a = S.res.analysis;
  if (!S.res.format.ok || !a) { el.innerHTML = '<div class="lock">🔒 第 ② 步「字数统计」在格式校验通过后自动解锁</div>'; return; }
  const unit = a.lang === 'en' ? '词' : '字';
  const eps = a.episodes.map((e) => { const n = e.counts[S.caliber]; return { ...e, n, v: verdict(n) }; });
  const bad = eps.filter((e) => e.v.kind !== 'ok');
  const avg = eps.length ? Math.round(eps.reduce((x, e) => x + e.n, 0) / eps.length) : 0;
  const rej = bad.length ? `<div class="reject"><h3>需打回 ${bad.length} 集</h3><div class="rows">${bad.map((e) => `<div class="rej"><span class="ep">第${e.no}集</span><span class="t">${esc(e.title || '')}</span><span class="w">${fmt(e.n)}</span><span class="tag">${e.v.label}${e.v.diff ? ' ' + fmt(e.v.diff) : ''}</span></div>`).join('')}</div></div>` : '<div class="pass-banner">✓ 全部集数字数合格，无需打回</div>';
  el.innerHTML = `<div class="bar" style="position:static;margin:18px 0 0;padding:0 0 10px">
      <div class="group cal"><span class="label">统计口径</span><div class="seg" role="radiogroup"><button data-a="cal" data-v="full" role="radio" aria-checked="${S.caliber === 'full'}">整集正文</button><button data-a="cal" data-v="pure" role="radio" aria-checked="${S.caliber === 'pure'}">纯台词+动作</button></div></div>
      <div class="group"><span class="label">合格区间</span><div class="range"><input id="min" type="number" min="0" value="${S.min}"><span>–</span><input id="max" type="number" min="1" value="${S.max}"><span class="unit">${unit}</span></div></div></div>
    <article class="book ${bad.length ? 'has-bad' : ''}">
      <header class="book-head"><div class="grow"><h2>${esc(S.name)}</h2><div class="meta">② 字数统计 · ${a.lang === 'en' ? '英文剧本 · 按单词计数' : '含标点与英文词 · 不含外译'}</div></div>${bad.length ? '<button class="btn sm" data-a="copy">复制打回清单</button>' : ''}</header>
      <div class="chips"><span class="chip">共 <b>${eps.length}</b> 集</span><span class="chip ok">合格 <b>${eps.length - bad.length}</b></span>${bad.length ? `<span class="chip bad">打回 <b>${bad.length}</b></span>` : ''}<span class="chip">平均 <b>${fmt(avg)}</b> ${unit}</span>${(a.issues || []).map((i) => `<span class="chip warn">⚠ ${esc(i.text)}</span>`).join('')}</div>
      ${eps.length ? chartHTML(eps, unit) : ''}${rej}
      <details><summary>各集明细（${eps.length} 集）</summary><div class="tbl-wrap"><table class="tbl"><thead><tr><th>集</th><th>场数</th><th>整集正文</th><th>纯台词+动作</th><th>状态</th></tr></thead><tbody>
      ${eps.map((e) => `<tr class="${e.v.kind !== 'ok' ? 'bad' : ''}"><td>第${e.no}集</td><td>${e.scenes}</td><td class="${S.caliber === 'full' ? 'cur' : ''}">${fmt(e.counts.full)}</td><td class="${S.caliber === 'pure' ? 'cur' : ''}">${fmt(e.counts.pure)}</td><td>${e.v.kind === 'ok' ? '✓' : `<span class="tag">${e.v.label}${e.v.diff ? ' ' + fmt(e.v.diff) : ''}</span>`}</td></tr>`).join('')}</tbody></table></div></details></article>`;
  S.rows = { bad, unit, a };
}

function copyReject() {
  const { bad, unit } = S.rows;
  const t = [`《${S.name}》字数要求 ${S.min}–${S.max}，需打回 ${bad.length} 集：`, ...bad.map((e) => `第${e.no}集：${e.v.kind === 'empty' ? '空集' : `${fmt(e.n)} ${unit}，${e.v.kind === 'short' ? '少' : '多'} ${fmt(e.v.diff)} ${unit}`}`)].join('\n');
  (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast('已复制打回清单'), () => toast('复制失败，请手动选择'));
}

/* ---------- 事件 ---------- */
function applyFix(id) {
  const it = S.res.format.issues.find((x) => x.id === id); if (!it || !it.fix) return;
  const f = it.fix;
  if (f.op === 'set') S.paras[it.para] = f.text;
  else if (f.op === 'insertBefore') S.paras.splice(it.para, 0, f.text);
  else if (f.op === 'delete') S.paras.splice(it.para, 1);
  recheck();
}
function gotoPara(p) {
  if (p === '' || p == null) return;
  if (S.onlyBad === false) { /* 直接滚动 */ }
  const el = $('p' + p); if (!el) { S.onlyBad = true; render(); return gotoPara(p); }
  el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1300);
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-a]');
  if (btn) {
    const a = btn.dataset.a; const i = Number(btn.dataset.i);
    if (a === 'autofix') autofix();
    else if (a === 'recheck') recheck();
    else if (a === 'download') download();
    else if (a === 'goto') gotoPara(btn.dataset.p);
    else if (a === 'fix') applyFix(Number(btn.dataset.id));
    else if (a === 'cancel') { S.editing = -1; render(); }
    else if (a === 'save') { S.paras[i] = $('ta').value.split('\n').map((x) => x.trim()).filter(Boolean).join('\n') || S.paras[i]; recheck(); }
    else if (a === 'del') { S.paras.splice(i, 1); recheck(); }
    else if (a === 'addafter') { S.paras.splice(i + 1, 0, '△'); S.editing = i + 1; recheck(); }
    else if (a === 'cal') { S.caliber = btn.dataset.v; renderCount(); }
    else if (a === 'copy') copyReject();
    else if (a === 'tab') { const b = books.find((x) => x.id === Number(btn.dataset.id)); if (b && b !== cur) select(b); }
    else if (a === 'rm') {
      e.stopPropagation();
      const k = books.findIndex((x) => x.id === Number(btn.dataset.id)); if (k < 0) return;
      const gone = books.splice(k, 1)[0];
      if (gone === cur) { cur = null; books.length ? select(books[Math.min(k, books.length - 1)]) : (S.res = null, $('stage').hidden = true, $('steps').hidden = true, renderTabs()); } else renderTabs();
    }
    return;
  }
  const row = e.target.closest('.paper .p[data-i]');
  if (row && S.editing < 0 && !window.getSelection().toString()) {
    S.editing = Number(row.dataset.i); render();
    const ta = $('ta'); if (ta) { ta.focus(); $('p' + S.editing).scrollIntoView({ block: 'nearest' }); }
  }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'onlyBad') { S.onlyBad = e.target.checked; render(); }
  if (e.target.id === 'min' || e.target.id === 'max') { S.min = Number($('min').value) || 0; S.max = Number($('max').value) || 1; renderCount(); }
});

const drop = $('drop'); const input = $('file');
drop.addEventListener('click', () => input.click());
drop.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), input.click()));
input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => { e.preventDefault(); addFiles(e.dataTransfer.files); });

fetch('/api/me').then((r) => (r.ok ? r.json() : null)).then((me) => { if (me && me.auth) { $('logout').title = `当前账号：${me.user}`; $('logout').hidden = false; } }).catch(() => {});
$('logout').addEventListener('click', async () => { try { await fetch('/api/logout', { method: 'POST' }); } finally { location.href = '/login'; } });

/* ---------- 左侧缩略定位轴 ---------- */
let mm = { y: [], h: 0 };
function buildMinimap() {
  const el = $('minimap'); if (!S.res) return;
  const blocks = S.res.format.blocks; const n = blocks.length || 1;
  const H = el.clientHeight || 400;
  const unit = H / n;
  const sev = (b) => { const it = b.issues.map((id) => S.res.format.issues.find((x) => x.id === id)).filter(Boolean); return it.some((x) => x.level === 'error') ? 'e' : it.length ? 'w' : ''; };
  let html = '';
  // 为避免上万个节点，按像素桶合并：同桶内取最严重的颜色
  const buckets = Math.min(n, Math.max(1, Math.floor(H / 2)));
  const rank = { '': 0, h: 1, ep: 1, w: 2, e: 3 };
  const cls = new Array(buckets).fill('');
  blocks.forEach((b, i) => { const k = Math.min(buckets - 1, Math.floor(i / n * buckets)); const c = sev(b) || (b.kind === 'h2' || b.kind === 'title' ? 'h' : b.kind === 'ep' ? 'ep' : ''); if (rank[c] > rank[cls[k]]) cls[k] = c; });
  const bh = H / buckets;
  cls.forEach((c, k) => { html += `<i class="mm ${c}" style="top:${(k * bh).toFixed(1)}px;height:${Math.max(2, bh - 0.5).toFixed(1)}px"></i>`; });
  el.innerHTML = html + '<div class="view" id="mmView"></div><div class="tip" id="mmTip"></div>';
  mm = { n, H };
  syncMinimap();
}
function paraEl(i) { return $('p' + i); }
function syncMinimap() {
  const v = $('mmView'); const w = document.querySelector('.paper-wrap'); if (!v || !w || !mm.n) return;
  const paper = $('paper'); const total = Math.max(1, paper.offsetHeight);
  const top = w.scrollTop; const vh = w.clientHeight;
  v.style.top = `${Math.max(0, (top / total) * mm.H)}px`;
  v.style.height = `${Math.max(8, Math.min(mm.H, (vh / total) * mm.H))}px`;
}
function mmJump(clientY, smooth) {
  const el = $('minimap'); const w = document.querySelector('.paper-wrap'); if (!w) return;
  const r = el.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (clientY - r.top) / r.height));
  const paper = $('paper');
  w.scrollTo({ top: ratio * paper.offsetHeight - w.clientHeight / 2, behavior: smooth ? 'smooth' : 'auto' });
}
(() => {
  const el = $('minimap'); let drag = false;
  el.addEventListener('pointerdown', (e) => { drag = true; el.setPointerCapture(e.pointerId); mmJump(e.clientY, false); });
  el.addEventListener('pointermove', (e) => {
    if (drag) mmJump(e.clientY, false);
    const tip = $('mmTip'); if (!tip || !S.res) return;
    const r = el.getBoundingClientRect(); const ratio = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    const i = Math.min(S.res.format.blocks.length - 1, Math.floor(ratio * S.res.format.blocks.length));
    let label = `第 ${i + 1} 行`;
    for (let k = i; k >= 0; k--) { const b = S.res.format.blocks[k]; if (b.kind === 'ep') { label = b.text; break; } if (b.kind === 'h2') { label = b.text; break; } }
    tip.textContent = label; tip.style.top = `${e.clientY - r.top}px`;
  });
  el.addEventListener('pointerup', () => { drag = false; });
  document.querySelector('.paper-wrap').addEventListener('scroll', syncMinimap, { passive: true });
  window.addEventListener('resize', () => { if (S.res) buildMinimap(); });
})();
