'use strict';

const MAX_BOOKS = 10;
const CONCURRENCY = 4;
const EXTS = ['.docx', '.txt', '.md'];
const CALIBERS = { full: '整集原文', pure: '纯台词+动作' };

const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString('zh-CN');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  books: [],          // { id, file, name, size, status: queued|running|done|error, result, error }
  caliber: 'full',
  min: 550,
  max: 1000,
  onlyBad: false,
  open: new Set(),    // 展开了明细的书
};
let seq = 0;

/* ---------------- 判定 ---------------- */

function verdict(n) {
  if (n === 0) return { kind: 'empty', label: '空集', diff: 0 };
  if (n < state.min) return { kind: 'short', label: '偏少', diff: state.min - n };
  if (n > state.max) return { kind: 'long', label: '超长', diff: n - state.max };
  return { kind: 'ok', label: '合格', diff: 0 };
}

function summarize(book) {
  const eps = book.result.episodes.map((e) => {
    const n = e.counts[state.caliber];
    return { ...e, n, v: verdict(n) };
  });
  const bad = eps.filter((e) => e.v.kind !== 'ok');
  const avg = eps.length ? Math.round(eps.reduce((s, e) => s + e.n, 0) / eps.length) : 0;
  return { eps, bad, avg };
}

/* ---------------- 上传（并发池 + 503 退避重试） ---------------- */

let running = 0;
function pump() {
  while (running < CONCURRENCY) {
    const b = state.books.find((x) => x.status === 'queued');
    if (!b) return;
    b.status = 'running';
    running++;
    analyze(b).finally(() => { running--; pump(); });
  }
}

async function analyze(book) {
  render();
  try {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'X-Filename': encodeURIComponent(book.file.name), 'Content-Type': 'application/octet-stream' },
        body: book.file,
      });
      if (res.status === 503 && attempt < 4) {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        continue;
      }
      if (res.status === 401) { location.href = '/login?expired=1'; throw new Error('登录已过期，正在跳转…'); }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `服务器返回 ${res.status}`);
      book.result = data;
      book.status = 'done';
      return;
    }
  } catch (e) {
    book.status = 'error';
    book.error = e.message === 'Failed to fetch' ? '无法连接服务器' : e.message;
  } finally {
    render();
  }
}

function addFiles(list) {
  const files = [...list];
  let skipped = 0, over = 0, dup = 0;
  for (const f of files) {
    const ext = (f.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
    if (!EXTS.includes(ext)) { skipped++; continue; }
    if (state.books.some((b) => b.file.name === f.name && b.file.size === f.size)) { dup++; continue; }
    if (state.books.length >= MAX_BOOKS) { over++; continue; }
    state.books.push({ id: ++seq, file: f, name: f.name.replace(/\.[^.]+$/, ''), status: 'queued' });
  }
  const notes = [];
  if (over) notes.push(`最多同时分析 ${MAX_BOOKS} 本，已忽略 ${over} 个`);
  if (skipped) notes.push(`${skipped} 个文件格式不支持（仅 .docx / .txt / .md）`);
  if (dup) notes.push(`${dup} 个文件已在列表中`);
  if (notes.length) toast(notes.join('；'));
  render();
  pump();
}

/* ---------------- 渲染 ---------------- */

let raf = 0;
function render() {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(draw);
}

function draw() {
  const has = state.books.length > 0;
  $('bar').hidden = !has;
  $('summary').hidden = !has;
  $('ruleText').textContent = `${state.min}–${state.max}`;
  for (const b of document.querySelectorAll('#caliber button')) b.setAttribute('aria-checked', String(b.dataset.v === state.caliber));

  const done = state.books.filter((b) => b.status === 'done');
  let eps = 0, bad = 0;
  for (const b of done) { const s = summarize(b); eps += s.eps.length; bad += s.bad.length; }
  $('summary').innerHTML = `
    <div class="card"><div class="n">${done.length}<small style="font-size:16px"> / ${state.books.length}</small></div><div class="l">已分析剧本</div></div>
    <div class="card"><div class="n">${fmt(eps)}</div><div class="l">总集数</div></div>
    <div class="card good"><div class="n">${fmt(eps - bad)}</div><div class="l">字数合格</div></div>
    <div class="card bad"><div class="n">${fmt(bad)}</div><div class="l">需打回编剧重申</div></div>`;

  $('books').innerHTML = has ? state.books.map(bookHTML).join('') : '';
}

function bookHTML(b) {
  const head = (extra = '') => `
    <header class="book-head">
      <div class="grow"><h2>${esc(b.name)}</h2><div class="meta">${esc(b.file.name.split('.').pop().toUpperCase())} · ${(b.file.size / 1024).toFixed(0)} KB</div></div>
      ${extra}
      <button class="btn ghost sm" data-act="remove" data-id="${b.id}">移除</button>
    </header>`;

  if (b.status === 'queued' || b.status === 'running') {
    return `<article class="book">${head()}<div class="state"><span class="spinner"></span>${b.status === 'queued' ? '排队中…' : '分析中…'}</div></article>`;
  }
  if (b.status === 'error') {
    return `<article class="book has-bad">${head(`<button class="btn sm" data-act="retry" data-id="${b.id}">重试</button>`)}
      <div class="state err"><b>解析失败</b> ${esc(b.error)}</div></article>`;
  }

  const { eps, bad, avg } = summarize(b);
  const issues = b.result.issues || [];
  const en = b.result.lang === 'en';
  const unit = en ? '词' : '字';
  const actions = bad.length ? `<button class="btn sm" data-act="copy" data-id="${b.id}">复制打回清单</button>` : '';

  const chips = `<div class="chips">
      <span class="chip">共 <b>${eps.length}</b> 集</span>
      <span class="chip ok">合格 <b>${eps.length - bad.length}</b></span>
      ${bad.length ? `<span class="chip bad">打回 <b>${bad.length}</b></span>` : ''}
      <span class="chip">平均 <b>${fmt(avg)}</b> ${unit}</span>
      <span class="chip rule" title="${en ? '识别为英文剧本：按英文单词计数（≥2 个字母，数字与标点不计）' : '识别为中文剧本：汉字、标点各计 1 字，英文单词每词计 1 字；数字、空白不计'}">${en ? '英文剧本 · 按单词计数' : '含标点与英文词'}</span>
      ${issues.map((i) => `<span class="chip warn">⚠ ${esc(i.text)}</span>`).join('')}
    </div>`;

  return `<article class="book ${bad.length ? 'has-bad' : ''}">
    ${head(actions)}
    ${chips}
    ${eps.length ? chartHTML(eps, unit) : ''}
    ${bad.length ? rejectHTML(bad) : eps.length ? '<div class="pass-banner">✓ 全部集数字数合格，无需打回</div>' : ''}
    ${eps.length ? detailHTML(b, eps) : ''}
  </article>`;
}

function chartHTML(eps, unit) {
  // 纵轴封顶在合格上限的 1.6 倍，个别超长集只截断显示并标出真实字数，不把其它集压扁
  const top = Math.min(state.max * 1.6, Math.max(state.max * 1.25, ...eps.map((e) => e.n)) * 1.05);
  const pct = (n) => Math.min(100, (n / top) * 100);
  const cols = eps.map((e) => {
    const bad = e.v.kind !== 'ok';
    const clip = e.n > top;
    const tip = `第${e.no}集 · ${fmt(e.n)} ${unit}` + (bad ? `（${e.v.label}${e.v.diff ? ' ' + fmt(e.v.diff) + ' ' + unit : ''}）` : '');
    return `<div class="col ${bad ? 'bad' : ''} ${e.v.kind === 'empty' ? 'empty' : ''} ${clip ? 'clip' : ''}" title="${esc(tip)}">${clip ? `<b class="clipn">${fmt(e.n)}</b>` : ''}<i style="height:${pct(e.n)}%"></i></div>`;
  }).join('');
  // 横轴刻度：按实际列宽决定隔几集标一个，避免窄屏数字挤成一团
  const plotW = Math.max(120, $('books').clientWidth - 2 * (innerWidth <= 720 ? 14 : 20) - (innerWidth <= 720 ? 34 : 40) - 2);
  const colW = Math.min(56, (plotW - (eps.length - 1) * 3) / eps.length) + 3;
  const labelW = String(Math.max(...eps.map((e) => e.no))).length * 7 + 14;
  const step = Math.max(1, Math.ceil(labelW / colW));
  const axis = eps.map((e, i) => {
    const bad = e.v.kind !== 'ok';
    return `<span class="${bad ? 'bad' : ''}">${i % step === 0 || (bad && step <= 2) ? e.no : ''}</span>`;
  }).join('');
  return `<div class="chart">
    <div class="plot">
      ${cols}
      <div class="band" style="bottom:${pct(state.min)}%;height:${pct(state.max) - pct(state.min)}%"><span class="hi">${state.max}</span><span class="lo">${state.min}</span></div>
    </div>
    <div class="axis">${axis}</div>
  </div>`;
}

function rejectHTML(bad) {
  return `<div class="reject"><h3>需打回 ${bad.length} 集</h3><div class="rows">${bad.map((e) => `
    <div class="rej"><span class="ep">第${e.no}集</span><span class="t">${esc(e.title)}</span>
      <span class="w">${fmt(e.n)}</span><span class="tag">${e.v.label}${e.v.diff ? ' ' + fmt(e.v.diff) : ''}</span></div>`).join('')}</div></div>`;
}

function detailHTML(b, eps) {
  const shown = state.onlyBad ? eps.filter((e) => e.v.kind !== 'ok') : eps;
  const c = state.caliber;
  const td = (k, n) => `<td class="${c === k ? 'cur' : ''}">${fmt(n)}</td>`;
  return `<details data-id="${b.id}" ${state.open.has(b.id) ? 'open' : ''}><summary>各集明细（${shown.length} 集）</summary>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>集</th><th>标题</th><th>场数</th><th>整集原文</th><th>纯台词+动作</th><th>状态</th></tr></thead><tbody>
    ${shown.map((e) => `<tr class="${e.v.kind !== 'ok' ? 'bad' : ''}"><td>第${e.no}集</td><td class="t">${esc(e.title)}</td><td>${e.scenes}</td>
      ${td('full', e.counts.full)}${td('pure', e.counts.pure)}
      <td>${e.v.kind === 'ok' ? '✓' : `<span class="tag">${e.v.label}${e.v.diff ? ' ' + fmt(e.v.diff) : ''}</span>`}</td></tr>`).join('')}
    </tbody></table></div></details>`;
}

/* ---------------- 导出 / 复制 ---------------- */

function rejectText(b) {
  const { eps, bad } = summarize(b);
  const en = b.result.lang === 'en';
  const unit = en ? '词' : '字';
  const lines = [`《${b.name}》共 ${eps.length} 集，正文${en ? '英文单词数' : '字数（含标点与英文单词）'}要求 ${state.min}–${state.max}（${CALIBERS[state.caliber]}），以下 ${bad.length} 集不合格，请重申：`];
  for (const e of bad) {
    const why = e.v.kind === 'empty' ? '空集，无正文' : e.v.kind === 'short' ? `${fmt(e.n)} ${unit}，少 ${fmt(e.v.diff)} ${unit}` : `${fmt(e.n)} ${unit}，多 ${fmt(e.v.diff)} ${unit}`;
    lines.push(`第${e.no}集${e.title ? '「' + e.title + '」' : ''}：${why}`);
  }
  for (const i of b.result.issues || []) lines.push(`另：${i.text}`);
  return lines.join('\n');
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  toast('已复制打回清单');
}

function csvText() {
  // 中文剧本统计汉字、标点和英文词；英文剧本数单词。最后一列为 WPS 参考值。
  const rows = [['剧本', '集', '标题', '场数', '计数方式', '整集原文', '纯台词+动作', `判定(${CALIBERS[state.caliber]} ${state.min}-${state.max})`, '差值', 'WPS字数(参考,含标点与英文)']];
  for (const b of state.books.filter((x) => x.status === 'done')) {
    for (const e of summarize(b).eps) {
      rows.push([b.name, e.no, e.title, e.scenes, b.result.lang === 'en' ? '英文单词' : '汉字+标点+英文单词', e.counts.full, e.counts.pure, e.v.label, e.v.diff, e.words[state.caliber]]);
    }
  }
  return '\uFEFF' + rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
}

function exportCSV() {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csvText()], { type: 'text/csv;charset=utf-8' }));
  a.download = `字数统计_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

/* ---------------- 事件 ---------------- */

const drop = $('drop'), input = $('file');
drop.addEventListener('click', () => input.click());
drop.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), input.click()));
input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });

let depth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; document.body.classList.add('dragging'); });
window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  depth = 0;
  document.body.classList.remove('dragging');
  if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files);
});

$('caliber').addEventListener('click', (e) => {
  const v = e.target.closest('button')?.dataset.v;
  if (v) { state.caliber = v; render(); }
});
for (const [id, key] of [['min', 'min'], ['max', 'max']]) {
  $(id).addEventListener('input', (e) => {
    const n = parseInt(e.target.value, 10);
    if (Number.isFinite(n) && n >= 0) { state[key] = n; render(); }
  });
}
$('onlyBad').addEventListener('change', (e) => { state.onlyBad = e.target.checked; render(); });
$('exportBtn').addEventListener('click', () => (state.books.some((b) => b.status === 'done') ? exportCSV() : toast('还没有分析完成的剧本')));
$('clearBtn').addEventListener('click', () => { state.books = []; state.open.clear(); render(); });

$('books').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const b = state.books.find((x) => x.id === Number(btn.dataset.id));
  if (!b) return;
  if (btn.dataset.act === 'remove') state.books = state.books.filter((x) => x !== b);
  else if (btn.dataset.act === 'retry') { b.status = 'queued'; pump(); }
  else if (btn.dataset.act === 'copy') return copy(rejectText(b));
  render();
});
$('books').addEventListener('toggle', (e) => {
  const d = e.target;
  if (d.tagName !== 'DETAILS') return;
  const id = Number(d.dataset.id);
  d.open ? state.open.add(id) : state.open.delete(id);
}, true);

window.addEventListener('resize', () => state.books.length && render());
render();

// 登录态：启用了登录才显示「退出登录」
fetch('/api/me')
  .then((r) => (r.ok ? r.json() : null))
  .then((me) => {
    if (!me || !me.auth) return;
    $('logout').title = `当前账号：${me.user}`;
    $('logout').hidden = false;
  })
  .catch(() => {});
$('logout').addEventListener('click', async () => {
  try { await fetch('/api/logout', { method: 'POST' }); } finally { location.href = '/login'; }
});
