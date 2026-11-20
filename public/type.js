'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => n.toLocaleString('zh-CN');
const MAX_BOOKS = 100;
const CONCURRENCY = 2;
const EXTS = ['.docx', '.txt', '.md'];
// S 是「当前选中那一本」的视图；books 保存每本的状态
const S = { marks: {}, showTr: true, name: '', paras: [], res: null, editing: -1, onlyBad: false, min: 550, max: 1000, incScene: false, incCast: false, view: 1, exporting: false, expandedSummary: new Set() };
let batchFixing = false;
let batchExportBooks = null;
// 字数 = 台词与动作 +（可选）场次头 +（可选）人物行；默认两者都不计
const countOf = (c, p) => c.pure + (S.incScene ? p.scene : 0) + (S.incCast ? p.cast : 0);
const modeText = () => (S.incScene || S.incCast ? `计入${[S.incScene && '场次头', S.incCast && '人物行'].filter(Boolean).join('、')}` : '不计场次头、人物行');
const books = []; let cur = null; let seq = 0;

const handoff = createWorkbenchReceiver({
  window,
  maxBooks: MAX_BOOKS,
  existingCount: () => books.length,
  addFile: (file) => addFiles([file], true)[0],
  getProgress: (book) => {
    if (book.rechecking) return { status: 'running', stage: '正在重新校验' };
    if (book.dirty) return { status: 'error', stage: '修改后待校验', error: book.error || '修改后的正文尚未通过重新校验' };
    if (book.status === 'queued') return { status: 'queued', stage: '等待校验' };
    if (book.status === 'running') return { status: 'running', stage: '正在校验与统计' };
    if (book.status === 'error') return { status: 'error', stage: '校验失败', error: book.error || '校验失败，请重新导入' };
    if (!book.res?.format.ok || !book.res.analysis) return { status: 'error', stage: '格式需调整', error: (book.res?.format.issues || []).filter((issue) => issue.level === 'error').slice(0, 3).map((issue) => issue.message).join('；') || '请在下方修改格式后重新校验' };
    return { status: 'done', stage: '统计完成' };
  },
  onChange: renderImport,
  onError: toast,
});
window.addEventListener('pagehide', () => handoff.destroy(), { once: true });

function renderImport(batch) {
  const box = $('workbenchImport');
  if (!batch) { box.hidden = true; return; }
  const complete = batch.items.filter((item) => item.status === 'done').length;
  const failed = batch.items.filter((item) => item.status === 'error').length;
  box.hidden = false;
  box.innerHTML = `<div class="import-head"><strong>从直出平台导入 ${batch.received} / ${batch.total} 本</strong><span>统计完成 ${complete} 本${failed ? ` · 需处理 ${failed} 本` : ''}</span></div><p>${batch.received === batch.total ? 'Word 已全部接收，可在下方查看、修改和导出。' : batch.sourceComplete ? '已接收的剧本继续统计；准备失败的剧本可在直出平台单独重试。' : '正在自动接收 Word，请保留直出平台原页面。准备好的剧本会先进入统计。'} 本次内容仅保留在当前页面，刷新后需重新导入。</p><ol>${batch.items.map((item) => `<li class="${item.status === 'error' ? 'bad' : ''}"><span>${esc(item.name.replace(/\.docx$/i, ''))}</span><small>${esc(item.stage)}${item.error ? `：${esc(item.error)}` : ''}</small></li>`).join('')}</ol>`;
}

function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 3000); }

async function call(url, opts) {
  const r = await fetch(url, opts);
  if (r.status === 401) { location.href = '/login?expired=1'; throw new Error('登录已过期'); }
  if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || `服务器返回 ${r.status}`); }
  return r;
}
const postJSON = (url, body) => call(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function select(b) {
  if (!books.includes(b)) return;
  if (cur) cur.onlyBad = S.onlyBad;
  cur = b;
  loadCurrent();
  refreshBooks();
  render();
}

function loadCurrent() {
  S.name = cur?.name || ''; S.paras = cur?.paras || []; S.res = cur?.res || null;
  S.marks = S.res?.marks || {}; S.editing = cur?.editDraft?.para ?? -1; S.onlyBad = !!cur?.onlyBad;
}

const auditOptions = () => ({ min: S.min, max: S.max, incScene: S.incScene, incCast: S.incCast });
const summaryData = () => AuditSummary.summarizeBooks(books, auditOptions());
const pendingBook = (b) => !!(b && (b.dirty || b.rechecking || b.status === 'queued' || b.status === 'running'));

function refreshBooks() {
  renderTabs(); renderFormatOverview(); renderSummary(); setSteps();
}

function showStep(step) {
  S.view = [1, 2, 3].includes(Number(step)) ? Number(step) : 1;
  refreshBooks();
  if (S.view !== 3) render();
  hideSel();
  if (S.view !== 3 && S.res) requestAnimationFrame(buildMinimap);
}

function renderTabs() {
  $('tabs').hidden = books.length === 0 || S.view === 3;
  const label = { queued: ['排队', 'run'], running: ['校验中', 'run'], rechecking: ['重校验中', 'run'], error: ['校验失败', 'bad'] };
  $('tabs').innerHTML = books.map((b) => {
    const st = b.rechecking ? label.rechecking : b.dirty ? ['修改待校验', 'run'] : b.status === 'done' ? (b.res?.format.ok ? ['格式通过', 'ok'] : [`格式 ${b.res?.format.errors || 0} 错`, 'bad']) : label[b.status] || label.error;
    return `<div class="tab ${b === cur ? 'cur' : ''}"><button class="tab-select" data-a="tab" data-id="${b.id}" title="${esc(b.file.name)}" aria-pressed="${b === cur}"><span class="nm">${esc(b.name)}</span><span class="st ${st[1]}">${st[0]}</span></button><button class="x" data-a="rm" data-id="${b.id}" title="移除《${esc(b.name)}》">×</button></div>`;
  }).join('');
}

function renderFormatOverview() {
  if (S.view !== 1) return;
  const data = summaryData();
  const passed = books.filter((b) => !pendingBook(b) && b.status === 'done' && b.res?.format.ok).length;
  const angleBooks = books.filter((b) => !pendingBook(b) && b.status === 'done' && b.res?.format?.issues?.some((x) => x.code === 'model-output-angle-tag'));
  const allReady = books.length > 0 && books.every((b) => !pendingBook(b) && b.status === 'done');
  const batchAction = batchExportBooks
    ? `<button class="btn batch-primary" data-a="batch-export">一次性导出修复后 ZIP（${batchExportBooks.length} 本）</button>`
    : angleBooks.length && allReady
      ? `<button class="btn batch-primary" data-a="batch-fix" ${batchFixing ? 'disabled' : ''}>${batchFixing ? '正在批量修复…' : `一键修复全部尖括号（${angleBooks.length} 本有问题）`}</button>`
      : '';
  $('formatOverview').innerHTML = `<div class="overview-head"><div><h2>格式校验</h2><p>已导入 ${books.length} / ${MAX_BOOKS} 本 · 格式通过 ${passed} 本 · ${data.totals.pending} 本等待或处理中</p></div><div class="overview-actions">${batchAction}<button class="btn ghost" data-a="step" data-step="3" ${books.length ? '' : 'disabled'}>查看全本统计 →</button></div></div>${batchExportBooks ? '<p class="overview-note">已批量删除正文中的非法尖括号内容。压缩包包含本次导入的全部剧本，点击上方按钮一次性下载。</p>' : books.length ? '<p class="overview-note">上方每本按队列自动校验。选择下方剧本可查看问题和修改；“格式通过”只表示结构通过，字数是否合格请进入逐本审计。</p>' : '<p class="overview-note">拖入剧本或从直出平台导入后自动开始，每次并行处理 2 本。</p>'}`;
}

function renderSummary() {
  if (S.view !== 3) return;
  const data = summaryData();
  const cell = (value) => value == null ? '—' : fmt(value);
  const rows = data.books.map((b) => {
    const bad = b.badEpisodes || [];
    const expanded = S.expandedSummary.has(b.id);
    const visibleBad = expanded ? bad : bad.slice(0, 3);
    const toggle = bad.length > 3 ? `<button class="summary-toggle" data-a="summary-toggle" data-id="${b.id}" aria-expanded="${expanded}" aria-label="${esc(b.name)}：${expanded ? '收起异常集明细' : '展开全部异常集明细'}">${expanded ? '收起明细' : `展开其余 ${bad.length - 3} 集`}</button>` : '';
    const notes = (b.issues || []).map((issue) => issue.text).filter(Boolean).join('；');
    return `<tr class="${b.passed === false ? 'bad' : ''}"><td><button class="book-link" data-a="audit-book" data-id="${b.id}">${esc(b.name)}</button><small class="summary-status ${b.passed === true ? 'ok' : ''}">${esc(b.label)}${b.passed == null ? ' · 暂不计入字数结论' : ''}</small>${notes ? `<small class="summary-note">${esc(notes)}</small>` : ''}</td><td>${cell(b.totalEpisodes)}</td><td>${bad.length ? visibleBad.map((e) => `<div class="summary-line">第${e.no}集 <span class="tag">${esc(e.label)}</span></div>`).join('') + toggle : b.passed === true ? '无' : '—'}</td><td>${bad.length ? visibleBad.map((e) => `<div class="summary-line">${fmt(e.n)} ${b.unit}</div>`).join('') : '—'}</td></tr>`;
  }).join('');
  $('allStats').innerHTML = `<div class="overview-head"><div><h2>全本统计</h2><p>共 ${data.totals.books} 本 · 可统计 ${data.totals.ready} 本 · 字数合格 ${data.totals.qualified} 本 · 需处理 ${data.totals.needsWork} 本</p></div><button class="btn" data-a="excel" ${!books.length || S.exporting ? 'disabled' : ''}>${S.exporting ? '正在导出…' : '下载 Excel'}</button></div><p class="overview-note">统计范围：当前页面所有剧本。超标集包含字数不足、超限和空集；格式未通过、修改中、排队和失败的剧本保留状态。点击剧名可回到逐本审计。</p>${books.length ? `<div class="tbl-wrap summary-table"><table class="tbl"><thead><tr><th>剧本名称</th><th>剧本总集数</th><th>超标集</th><th>超标集字数</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="summary-empty">尚未导入剧本，导入后会自动在这里汇总。</p>'}`;
}

async function downloadSummary() {
  if (!books.length || S.exporting) return;
  const data = summaryData();
  const incomplete = data.books.filter((b) => b.passed == null);
  if (incomplete.length && !window.confirm(`还有 ${incomplete.length} 本尚无有效统计结果，Excel 会保留这些剧本及当前状态。是否导出当前全部 ${books.length} 本？`)) return;
  const payload = {
    books: books.map((b) => ({ id: b.id, name: b.name, status: b.status, error: b.error, dirty: b.dirty, rechecking: b.rechecking, format: b.res?.format && { ok: b.res.format.ok, errors: b.res.format.errors, warns: b.res.format.warns }, analysis: b.res?.analysis })),
    options: auditOptions(),
  };
  S.exporting = true; renderSummary();
  try {
    const r = await postJSON('/api/audit/export', payload);
    saveBlob(await r.blob(), '全本统计.xlsx');
    toast(`已导出 ${payload.books.length} 本剧本的统计`);
  } catch (e) { toast(e.message); }
  finally { S.exporting = false; renderSummary(); }
}

async function batchFixAngleTags() {
  if (batchFixing || !books.length || books.some((b) => pendingBook(b) || b.status !== 'done')) return;
  const angleBooks = books.filter((b) => b.res?.format?.issues?.some((x) => x.code === 'model-output-angle-tag'));
  if (!angleBooks.length) return;
  if (!window.confirm(`将一次性检查并修复全部 ${books.length} 本剧本中正文里的非法尖括号内容。修复会删除从 <note> 到 </note> 的整个 few-shot 说明块（包括其中的集号和文字），完成后可一次性导出全部剧本 ZIP。是否继续？`)) return;
  batchFixing = true; batchExportBooks = null; renderFormatOverview();
  try {
    const payload = { books: books.map((b) => ({ id: b.id, name: b.name, paragraphs: b.paras })) };
    const r = await postJSON('/api/fix-batch', payload);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '批量修复失败');
    let removed = 0; let fixedBooks = 0;
    for (const item of d.books || []) {
      const b = books.find((x) => x.id === item.id);
      if (!b) continue;
      b.paras = item.paragraphs || b.paras; b.res = item; b.status = 'done'; b.dirty = false; b.error = '';
      b.revision++; fixedBooks += Number(item.angleRemoved || 0) > 0 ? 1 : 0;
      removed += Number(item.angleRemoved || 0);
      handoff.bookChanged(b);
    }
    const invalid = (d.books || []).filter((item) => !item.format?.ok);
    batchExportBooks = invalid.length ? null : (d.books || []).map((item) => ({ id: item.id, name: item.name, paragraphs: item.paragraphs }));
    if (cur) { loadCurrent(); render(); }
    refreshBooks();
    toast(`已处理 ${d.total || 0} 本，其中 ${fixedBooks} 本已删除非法尖括号内容（共 ${removed} 处），优化结束${invalid.length ? `；仍有 ${invalid.length} 本存在其他格式错误，请逐本处理` : '；请一次性导出修复后的 ZIP'}`);
  } catch (e) { toast(e.message); }
  finally { batchFixing = false; renderFormatOverview(); }
}

async function downloadBatchFixed() {
  if (!batchExportBooks?.length) return;
  if (!window.confirm(`将一次性导出全部 ${batchExportBooks.length} 本已修复剧本，压缩包内每本对应一个 Word 文件。是否下载？`)) return;
  try {
    const r = await postJSON('/api/export-batch', { books: batchExportBooks });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || '批量导出失败');
    }
    saveBlob(await r.blob(), '修复后剧本.zip');
    toast(`已导出 ${batchExportBooks.length} 本修复后的剧本`);
  } catch (e) { toast(e.message); }
}

function saveBlob(blob, filename) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

let running = 0;
function pump() {
  while (running < CONCURRENCY) {
    const b = books.find((x) => x.status === 'queued');
    if (!b) return;
    b.status = 'running'; running++;
    handoff.bookChanged(b);
    validateOne(b).finally(() => { running--; pump(); });
  }
}

async function validateOne(b) {
  const revision = b.revision;
  refreshBooks();
  try {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch('/api/validate', { method: 'POST', headers: { 'X-Filename': encodeURIComponent(b.file.name), 'Content-Type': 'application/octet-stream' }, body: b.file });
      if (r.status === 503 && attempt < 5) { await new Promise((x) => setTimeout(x, 700 * (attempt + 1))); continue; }
      if (r.status === 401) { location.href = '/login?expired=1'; throw new Error('登录已过期'); }
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `服务器返回 ${r.status}`);
      if (!books.includes(b) || b.revision !== revision) return;
      b.name = d.name; b.paras = d.paragraphs; b.res = d; b.status = 'done'; b.error = ''; b.dirty = false;
      break;
    }
  } catch (e) { if (!books.includes(b) || b.revision !== revision) return; b.status = 'error'; b.error = e.message === 'Failed to fetch' ? '无法连接服务器' : e.message; }
  if (!books.includes(b)) return;
  handoff.bookChanged(b);
  if (!cur) select(b); else if (b === cur) { loadCurrent(); render(); }
  refreshBooks();
  if (b === cur && b.status === 'error') toast(`《${b.name}》${b.error}`);
}

function addFiles(list, imported = false) {
  if (batchFixing) { toast('批量修复进行中，请等待任务结束后再导入剧本'); return []; }
  if (list?.length) batchExportBooks = null;
  let skipped = 0; let over = 0; let dup = 0; let oversize = 0; const added = [];
  for (const f of [...list]) {
    const ext = (f.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
    if (!EXTS.includes(ext)) { skipped++; continue; }
    if (f.size > 30 * 1024 * 1024) { oversize++; continue; }
    if (!imported && books.some((b) => b.file.name === f.name && b.file.size === f.size)) { dup++; continue; }
    if (books.length >= MAX_BOOKS - (imported ? 0 : handoff.reservedCount())) { over++; continue; }
    const book = { id: ++seq, file: f, name: f.name.replace(/\.[^.]+$/, ''), status: 'queued', revision: 0, requestVersion: 0, dirty: false, rechecking: false };
    books.unshift(book); added.push(book);
  }
  const notes = [];
  if (over) notes.push(`最多同时 ${MAX_BOOKS} 本，已忽略 ${over} 个`);
  if (skipped) notes.push(`${skipped} 个文件格式不支持`);
  if (dup) notes.push(`${dup} 个文件已在列表中`);
  if (oversize) notes.push(`${oversize} 个文件超过 30MB`);
  if (notes.length) toast(notes.join('；'));
  refreshBooks(); pump();
  if (!cur && books.length) { /* 第一本校验完成后自动选中 */ }
  return added;
}

function commitDraft(b) {
  if (!b?.editDraft) return;
  const draft = b.editDraft;
  const text = draft.text.split('\n').map((x) => x.trim()).filter(Boolean).join('\n');
  if (text && text !== b.paras[draft.para]) { b.paras[draft.para] = text; b.dirty = true; b.revision++; }
  else b.dirty = draft.beforeDirty;
  b.editDraft = null;
}
async function checkBook(b, fix = false) {
  if (!b || !books.includes(b) || b.rechecking || !b.paras) return;
  commitDraft(b);
  if (b.dirty) b.onlyBad = false;
  const revision = b.revision; const requestVersion = ++b.requestVersion;
  const paragraphs = b.paras.slice(); const name = b.name;
  b.rechecking = true; b.status = 'rechecking'; b.error = '';
  if (b === cur) { loadCurrent(); render(); }
  refreshBooks(); handoff.bookChanged(b);
  try {
    const d = await (await postJSON(fix ? '/api/fix' : '/api/recheck', { name, paragraphs })).json();
    if (!books.includes(b) || b.revision !== revision || b.requestVersion !== requestVersion) return;
    b.paras = d.paragraphs || paragraphs; b.res = d; b.status = 'done'; b.dirty = false; b.error = '';
    if (fix) toast(`《${name}》已修复 ${d.applied} 处${d.format.ok ? '，格式通过' : `，还剩 ${d.format.errors} 个错误`}`);
  } catch (e) {
    if (!books.includes(b) || b.revision !== revision || b.requestVersion !== requestVersion) return;
    b.status = 'error'; b.dirty = true; b.error = e.message; toast(`《${name}》${e.message}`);
  } finally {
    if (books.includes(b) && b.requestVersion === requestVersion) {
      b.rechecking = false;
      if (b.revision !== revision && b.status === 'rechecking') { b.status = 'done'; b.dirty = true; }
      if (b === cur) { loadCurrent(); render(); }
      handoff.bookChanged(b); refreshBooks();
    }
  }
}
const recheck = () => checkBook(cur);
const autofix = () => checkBook(cur, true);
async function download() {
  const b = cur;
  if (!b || pendingBook(b) || b.status !== 'done' || !b.res?.format.ok) return toast('请先保存修改并完成格式校验');
  try {
    const name = b.name; const paragraphs = b.paras.slice();
    const r = await postJSON('/api/export', { name, paragraphs });
    saveBlob(await r.blob(), `${name}_标准格式.docx`);
  } catch (e) { toast(e.message); }
}

/* ---------- 渲染 ---------- */
function paraHTML(b) {
  const issues = b.issues.map((id) => S.res.format.issues.find((x) => x.id === id)).filter(Boolean);
  const hasErr = issues.some((x) => x.level === 'error');
  const cls = ['p', b.kind, b.kind === 'title' ? 'title' : '', b.kind === 'h2' ? 'h2' : '', issues.length ? (hasErr ? 'bad' : 'warnrow') : '', (b.kind === 'scene' && !S.incScene) || (b.kind === 'cast' && !S.incCast) ? 'nc' : ''].join(' ');
  let inner;
  if (S.editing === b.para) {
    return `<div class="${cls}" id="p${b.para}"><textarea id="ta" rows="${Math.min(8, b.text.split('\n').length + 1)}">${esc(cur?.editDraft?.text ?? b.text)}</textarea>
      <div class="rowact"><button data-a="save" data-i="${b.para}">保存</button><button data-a="cancel">取消</button><button data-a="del" data-i="${b.para}">删除本行</button><button data-a="addafter" data-i="${b.para}">下方新增一行</button></div></div>`;
  }
  const m = /^([^：\n]*：)([\s\S]*)$/.exec(b.text);
  if (['field', 'pfield', 'jigang'].includes(b.kind) && m) inner = `<b>${esc(m[1])}</b>${esc(m[2])}`;
  else if (['stage', 'ep'].includes(b.kind)) inner = `<b>${esc(b.text)}</b>`;
  else inner = esc(b.text);
  inner = markTranslations(b, inner);
  const why = issues.map((x) => `<span class="why ${x.level === 'warn' ? 'w' : ''}">${x.level === 'warn' ? '⚠' : '✗'} ${esc(x.message)}${x.fixable ? `<button data-a="fix" data-id="${x.id}">${x.fix.op === 'delete' ? '删除此行' : x.fix.op === 'insertBefore' ? `补上「${esc(x.fix.text)}」` : x.fix.op === 'removeAngle' ? '删除尖括号及其中内容' : '一键改为：' + esc(x.fix.text.slice(0, 40)).replace(/\n/g, ' ')}</button>` : ''}</span>`).join('');
  return `<div class="${cls}" id="p${b.para}" data-i="${b.para}" title="${/\bnc\b/.test(cls) ? '这一行不计字数（可在统计区「哪些算字数」勾选改变）；' : ''}点击修改本行；框选文字可统计字数"><span class="gutter">${b.para + 1}</span>${inner}${why}</div>`;
}

// 在原文里把「外语翻译」标出来（灰色删除线 = 不计字数）。只处理正文里的段落
function markTranslations(b, html) {
  const spans = S.marks[b.para];
  if (!spans || !spans.length || !S.showTr) return html;
  const text = b.text; let out = ''; let pos = 0;
  for (const [a, e] of spans) { out += esc(text.slice(pos, a)) + `<s class="tr" title="外语翻译：不计字数">${esc(text.slice(a, e))}</s>`; pos = e; }
  const rendered = out + esc(text.slice(pos));
  // 带「标签：」前缀的行，保持前半加粗
  const m = /^([^：\n]*：)/.exec(text);
  return ['field', 'pfield', 'jigang'].includes(b.kind) && m ? html : rendered;
}

// 空行位置与导出的标准 docx 保持一致
function paperHTML() {
  const blocks = cur?.dirty && !cur.editDraft ? S.paras.map((text, para) => ({ text, para, kind: 'text', issues: [] })) : S.res.format.blocks;
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
  setSteps();
  const r = S.res; if (!r || S.view === 3) return;
  const f = r.format;
  const pending = pendingBook(cur); const busy = !!cur?.rechecking;
  const paraIssues = f.issues.filter((x) => x.para != null);
  const global = f.issues.filter((x) => x.para == null);
  $('statusbar').className = `statusbar ${pending ? '' : f.ok ? 'pass' : 'fail'}`;
  const status = busy ? '正在重新校验，旧统计暂不参与汇总' : cur?.dirty ? (cur.error ? `校验失败：${esc(cur.error)}，请重新校验` : '正文已修改，请保存并重新校验') : f.ok ? '✓ 格式通过 · 字数是否合格请查看逐本审计' : '✗ 格式未通过，暂不统计字数';
  $('statusbar').innerHTML = `<div class="t">${status}<small>《${esc(S.name)}》 · ${S.paras.length} 段${pending ? '' : ` · 错误 ${f.errors} · 提示 ${f.warns}`}</small></div>
    <label class="chk"><input type="checkbox" id="onlyBad" ${S.onlyBad ? 'checked' : ''}>只看有问题的行</label>
    <label class="chk" title="被判为外语翻译的括号内容，不计字数"><input type="checkbox" id="showTr" ${S.showTr ? 'checked' : ''}>标出不计字数的翻译（${Object.values(S.marks || {}).reduce((n, m) => n + m.length, 0)} 处）</label>
    ${f.fixable && !cur?.dirty ? `<button class="btn" data-a="autofix" ${busy ? 'disabled' : ''}>一键自动修复（${f.fixable}）</button>` : ''}
    <button class="btn ghost" data-a="recheck" ${busy ? 'disabled' : ''}>${busy ? '重新校验中…' : '重新校验'}</button>
    <button class="btn ${f.ok && !pending ? '' : 'ghost'}" data-a="download" ${f.ok && !pending && cur.status === 'done' ? '' : 'disabled title="保存修改并通过格式校验后可导出"'}>下载标准格式 docx</button>`;
  const list = (arr) => arr.map((x) => `<button class="issue ${x.level}" data-a="goto" data-p="${x.para ?? ''}"><span class="lv">${x.level === 'error' ? '错误' : '提示'}</span>${esc(x.message)}${x.fixable ? '<span class="fx">可自动修复</span>' : ''}${x.para != null ? `<div class="ln">第 ${x.para + 1} 行：${esc((S.paras[x.para] || '').slice(0, 30))}</div>` : ''}</button>`).join('');
  const cap = 200;
  $('side').innerHTML = pending ? '<h3>正文正在更新</h3><p class="overview-note">重新校验完成后更新问题清单与字数。可以切换到其他剧本继续查看。</p>' : `<h3>问题清单（${f.issues.length}）</h3>${f.ok && !f.issues.length ? '<p class="empty-hint" style="padding:12px 0">没有问题。</p>' : ''}${list(global)}${list(paraIssues.slice(0, cap))}${paraIssues.length > cap ? `<p class="ln">仅显示前 ${cap} 条，其余请在右侧文档中查看。</p>` : ''}`;
  $('paper').innerHTML = paperHTML();
  $('paper').setAttribute('aria-busy', String(busy));
  $('paper').classList.toggle('is-checking', busy);
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
    return `<div class="col ${bad ? 'bad' : ''} ${e.v.kind === 'empty' ? 'empty' : ''} ${clip ? 'clip' : ''}" data-a="ep" data-ep="${e.no}" title="${esc(tip)}（点击定位到文档）">${clip ? `<b class="clipn">${fmt(e.n)}</b>` : ''}<i style="height:${pct(e.n)}%"></i></div>`;
  }).join('');
  const plotW = Math.max(120, $('count').clientWidth - 2 * (innerWidth <= 720 ? 14 : 20) - (innerWidth <= 720 ? 34 : 40) - 2);
  const colW = Math.min(56, (plotW - (eps.length - 1) * 3) / eps.length) + 3;
  const step = Math.max(1, Math.ceil((String(Math.max(...eps.map((e) => e.no))).length * 7 + 14) / colW));
  const axis = eps.map((e, i) => `<span class="${e.v.kind !== 'ok' ? 'bad' : ''}" data-a="ep" data-ep="${e.no}">${i % step === 0 || (e.v.kind !== 'ok' && step <= 2) ? e.no : ''}</span>`).join('');
  return `<div class="chart"><div class="plot">${cols}<div class="band" style="bottom:${pct(S.min)}%;height:${pct(S.max) - pct(S.min)}%"><span class="hi">${S.max}</span><span class="lo">${S.min}</span></div></div><div class="axis">${axis}</div></div>`;
}

function setSteps() {
  for (const n of [1, 2, 3]) {
    $('st' + n).className = S.view === n ? 'cur' : '';
    $('st' + n).setAttribute('aria-selected', String(S.view === n));
  }
  $('formatOverview').hidden = S.view !== 1;
  $('ruleControls').hidden = S.view === 1;
  $('allStats').hidden = S.view !== 3;
  $('stage').hidden = S.view === 3 || !S.res;
  $('count').hidden = S.view !== 2;
  $('tabs').hidden = S.view === 3 || !books.length;
  $('bookEmpty').hidden = S.view === 3 || !!S.res;
  $('bookEmpty').textContent = cur ? cur.status === 'error' ? `《${cur.name}》${cur.error || '校验失败，请重新导入'}` : `《${cur.name}》${cur.status === 'queued' ? '正在排队' : '正在校验'}，可选择其他已完成的剧本。` : books.length ? '剧本正在排队校验，完成后可逐本查看。' : '导入剧本后，在这里查看校验结果。';
}

function renderCount() {
  setSteps();
  $('ruleText').textContent = `${S.min}–${S.max}`;
  const el = $('count'); const a = S.res.analysis;
  S.rows = null;
  if (pendingBook(cur) || cur.status !== 'done') { el.innerHTML = '<div class="lock">正文正在修改或重新校验，旧字数已从全本统计中移除。</div>'; return; }
  if (!S.res.format.ok || !a) { el.innerHTML = '<div class="lock">逐本审计的字数结果在格式校验通过后显示；可在下方修改正文后重新校验。</div>'; return; }
  if (!a.episodes?.length) { el.innerHTML = '<div class="lock">未识别到正文集数，请检查正文标题与集号后重新校验。</div>'; return; }
  const unit = a.lang === 'en' ? '词' : '字';
  const eps = a.episodes.map((e) => { const n = countOf(e.counts, e.parts); return { ...e, n, v: verdict(n) }; });
  const bad = eps.filter((e) => e.v.kind !== 'ok');
  const avg = eps.length ? Math.round(eps.reduce((x, e) => x + e.n, 0) / eps.length) : 0;
  const rej = bad.length ? `<div class="reject"><h3>需打回 ${bad.length} 集</h3><div class="rows">${bad.map((e) => `<div class="rej" data-a="ep" data-ep="${e.no}" title="点击定位到文档"><span class="ep">第${e.no}集</span><span class="t">${esc(e.title || '')}</span><span class="w">${fmt(e.n)}</span><span class="tag">${e.v.label}${e.v.diff ? ' ' + fmt(e.v.diff) : ''}</span></div>`).join('')}</div></div>` : '<div class="pass-banner">✓ 全部集数字数合格，无需打回</div>';
  el.innerHTML = `<article class="book ${bad.length ? 'has-bad' : ''}">
      <header class="book-head"><div class="grow"><h2>${esc(S.name)}</h2><div class="meta">② 逐本审计 · ${a.lang === 'en' ? '英文剧本 · 按单词计数' : '含标点与英文词 · 不含外译'}</div></div>${bad.length ? '<button class="btn sm" data-a="copy">复制打回清单</button>' : ''}</header>
      <div class="chips"><span class="chip">共 <b>${eps.length}</b> 集</span><span class="chip ok">合格 <b>${eps.length - bad.length}</b></span>${bad.length ? `<span class="chip bad">打回 <b>${bad.length}</b></span>` : ''}<span class="chip">平均 <b>${fmt(avg)}</b> ${unit}</span>${(a.issues || []).map((i) => `<span class="chip warn">⚠ ${esc(i.text)}</span>`).join('')}</div>
      ${eps.length ? chartHTML(eps, unit) : ''}${rej}
      <details><summary>各集明细（${eps.length} 集）</summary><div class="tbl-wrap"><table class="tbl"><thead><tr><th>集</th><th>场数</th><th>字数</th><th>场次头(字)</th><th>人物行(字)</th><th>状态</th></tr></thead><tbody>
      ${eps.map((e) => `<tr class="${e.v.kind !== 'ok' ? 'bad' : ''}" data-a="ep" data-ep="${e.no}" style="cursor:pointer"><td>第${e.no}集</td><td>${e.scenes}</td><td class="cur">${fmt(e.n)}</td><td>${fmt(e.parts.scene)}</td><td>${fmt(e.parts.cast)}</td><td>${e.v.kind === 'ok' ? '✓' : `<span class="tag">${e.v.label}${e.v.diff ? ' ' + fmt(e.v.diff) : ''}</span>`}</td></tr>`).join('')}</tbody></table></div></details></article>`;
  S.rows = { bad, unit, a };
}

// HTTP 页面没有 navigator.clipboard（只在 HTTPS/localhost 可用），先试它，失败就用 execCommand 降级
async function copyText(text) {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch { /* 降级 */ }
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0';
  document.body.appendChild(ta); ta.focus(); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}
// 两种方式都失败时，弹出文本框并全选，用户按 Ctrl/Cmd+C 即可
function manualCopy(text) {
  let box = $('manualcopy');
  if (!box) { box = document.createElement('div'); box.id = 'manualcopy'; document.body.appendChild(box); }
  box.innerHTML = '<div class="mc-card"><div class="mc-t">自动复制不可用，请按 Ctrl/Cmd + C 复制</div><textarea readonly></textarea><button class="btn sm" data-a="mcclose">关闭</button></div>';
  const ta = box.querySelector('textarea'); ta.value = text; box.hidden = false; ta.focus(); ta.select();
}

function copyReject() {
  if (!S.rows) return;
  const { bad, unit } = S.rows;
  const t = [`《${S.name}》字数要求 ${S.min}–${S.max}，需打回 ${bad.length} 集：`, ...bad.map((e) => `第${e.no}集：${e.v.kind === 'empty' ? '空集' : `${fmt(e.n)} ${unit}，${e.v.kind === 'short' ? '少' : '多'} ${fmt(e.v.diff)} ${unit}`}`)].join('\n');
  copyText(t).then((ok) => (ok ? toast('已复制打回清单') : manualCopy(t)));
}

/* ---------- 事件 ---------- */
function applyFix(id) {
  if (!cur || pendingBook(cur)) return;
  const it = S.res.format.issues.find((x) => x.id === id); if (!it || !it.fix) return;
  const f = it.fix;
  if (f.op === 'set') S.paras[it.para] = f.text;
  else if (f.op === 'insertBefore') S.paras.splice(it.para, 0, f.text);
  else if (f.op === 'delete') S.paras.splice(it.para, 1);
  else if (f.op === 'removeAngle') {
    const startPara = Number.isInteger(f.startPara) ? f.startPara : it.para;
    const endPara = Number.isInteger(f.endPara) ? f.endPara : startPara;
    const start = Math.max(0, f.startIndex || 0);
    const end = Math.max(start, f.endIndex || start);
    if (startPara === endPara) {
      const text = String(S.paras[startPara] || '');
      S.paras[startPara] = text.slice(0, start) + text.slice(end);
      if (!S.paras[startPara]) S.paras.splice(startPara, 1);
    } else {
      const prefix = String(S.paras[startPara] || '').slice(0, start);
      const suffix = String(S.paras[endPara] || '').slice(end);
      S.paras.splice(startPara, endPara - startPara + 1, ...[prefix, suffix].filter(Boolean));
    }
  }
  cur.dirty = true; cur.revision++; recheck();
}
// 把某一行放到文档视窗正中（用相对容器的真实位置，不用 offsetTop，避免偏到下一集）
function centerRow(el, smooth = true) {
  const wrap = document.querySelector('.paper-wrap');
  const wr = wrap.getBoundingClientRect(); const er = el.getBoundingClientRect();
  const target = wrap.scrollTop + (er.top - wr.top) - (wrap.clientHeight - er.height) / 2;
  wrap.scrollTo({ top: Math.max(0, target), behavior: smooth ? 'smooth' : 'auto' });
}
function gotoEpisode(no) {
  if (!S.res || pendingBook(cur)) return;
  const blocks = S.res.format.blocks;
  const b = blocks.find((x) => x.kind === 'ep' && x.ep === no) || blocks.find((x) => x.kind === 'scene' && new RegExp(`^${no}[-－–—]`).test(x.text));
  if (!b) return toast(`文档里没有找到第${no}集的位置`);
  if (S.onlyBad) { S.onlyBad = false; render(); }
  // 先让整个文档区在页面里居中，再在文档区内把该集标题放到正中
  const cols = document.querySelector('.cols');
  const cr = cols.getBoundingClientRect();
  window.scrollTo({ top: window.scrollY + cr.top - Math.max(8, (window.innerHeight - cr.height) / 2), behavior: 'smooth' });
  const el = $('p' + b.para); if (!el) return;
  centerRow(el);
  document.querySelectorAll('.paper .p.epflash').forEach((x) => x.classList.remove('epflash'));
  el.classList.add('epflash'); setTimeout(() => el.classList.remove('epflash'), 2200);
}
function gotoPara(p) {
  if (p === '' || p == null) return;
  if (S.onlyBad === false) { /* 直接滚动 */ }
  const el = $('p' + p); if (!el) { S.onlyBad = true; render(); return gotoPara(p); }
  centerRow(el); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1300);
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-a]');
  if (btn) {
    const a = btn.dataset.a; const i = Number(btn.dataset.i);
    if (a === 'step') showStep(btn.dataset.step);
    else if (a === 'summary-toggle') { const id = Number(btn.dataset.id); if (S.expandedSummary.has(id)) S.expandedSummary.delete(id); else S.expandedSummary.add(id); renderSummary(); }
    else if (a === 'excel') downloadSummary();
    else if (a === 'batch-fix') batchFixAngleTags();
    else if (a === 'batch-export') downloadBatchFixed();
    else if (a === 'audit-book') { const b = books.find((x) => x.id === Number(btn.dataset.id)); if (b) { select(b); showStep(2); $('steps').scrollIntoView({ block: 'start', behavior: 'smooth' }); } }
    else if (a === 'autofix') autofix();
    else if (a === 'recheck') recheck();
    else if (a === 'download') download();
    else if (a === 'goto') gotoPara(btn.dataset.p);
    else if (a === 'ep') gotoEpisode(Number(btn.dataset.ep));
    else if (a === 'fix') applyFix(Number(btn.dataset.id));
    else if (a === 'cancel' && cur && !cur.rechecking) { if (cur.editDraft) cur.dirty = cur.editDraft.beforeDirty; cur.editDraft = null; loadCurrent(); render(); refreshBooks(); handoff.bookChanged(cur); }
    else if (a === 'save' && cur && !cur.rechecking) { if (cur.editDraft) cur.editDraft.text = $('ta').value; recheck(); }
    else if ((a === 'del' || a === 'addafter') && cur && !cur.rechecking) { if (a === 'del') S.paras.splice(i, 1); else S.paras.splice(i + 1, 0, '△'); cur.editDraft = null; cur.dirty = true; cur.revision++; recheck(); }
    else if (a === 'copy') copyReject();
    else if (a === 'tab') { const b = books.find((x) => x.id === Number(btn.dataset.id)); if (b && b !== cur) select(b); }
    else if (a === 'rm') {
      e.stopPropagation();
      if (batchFixing) return toast('批量修复进行中，请等待任务结束后再移除剧本');
      const k = books.findIndex((x) => x.id === Number(btn.dataset.id)); if (k < 0) return;
      const gone = books.splice(k, 1)[0];
      batchExportBooks = null;
      S.expandedSummary.delete(gone.id);
      gone.revision++; gone.requestVersion++;
      gone.importRemoved = true; handoff.bookChanged(gone);
      if (gone === cur) { cur = null; if (books.length) select(books[Math.min(k, books.length - 1)]); else { loadCurrent(); render(); } }
      refreshBooks();
    }
    return;
  }
  const row = e.target.closest('.paper .p[data-i]');
  if (row && cur && !cur.rechecking && S.editing < 0 && !window.getSelection().toString()) {
    S.editing = Number(row.dataset.i);
    cur.editDraft = { para: S.editing, text: S.paras[S.editing], beforeDirty: cur.dirty };
    render();
    const ta = $('ta'); if (ta) { ta.focus(); $('p' + S.editing).scrollIntoView({ block: 'nearest' }); }
  }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'onlyBad') { S.onlyBad = e.target.checked; render(); }
  if (e.target.id === 'showTr') { S.showTr = e.target.checked; render(); }
  if (e.target.id === 'incScene' || e.target.id === 'incCast') { S[e.target.id] = e.target.checked; render(); refreshBooks(); }
  if (e.target.id === 'min' || e.target.id === 'max') {
    try {
      const options = AuditSummary.normalizeOptions({ ...auditOptions(), min: $('min').value, max: $('max').value });
      S.min = options.min; S.max = options.max;
    } catch (error) { toast(error.message); }
    $('min').value = S.min; $('max').value = S.max;
    $('ruleText').textContent = `${S.min}–${S.max}`;
    if (S.res) renderCount(); refreshBooks();
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id !== 'ta' || !cur?.editDraft || cur.rechecking) return;
  cur.editDraft.text = e.target.value;
  cur.dirty = cur.editDraft.beforeDirty || e.target.value !== cur.paras[cur.editDraft.para];
  cur.revision++;
  // 输入时保留 textarea 与光标，只更新字数、按钮和其他汇总区域。
  $('statusbar').querySelector('[data-a="download"]').disabled = cur.dirty || !cur.res?.format.ok;
  if (S.res) renderCount();
  refreshBooks(); handoff.bookChanged(cur);
});

$('steps').addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  e.preventDefault();
  const next = e.key === 'Home' ? 1 : e.key === 'End' ? 3 : ((S.view - 1 + (e.key === 'ArrowRight' ? 1 : -1) + 3) % 3) + 1;
  showStep(next); $('st' + next).focus();
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

/* ---------- 框选统计字数 ---------- */
let selTimer = 0; let selSeq = 0;
function selectedParas() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const paper = $('paper');
  if (!paper.contains(range.commonAncestorContainer)) return null;
  const rows = [...paper.querySelectorAll('.p[data-i]')].filter((r) => range.intersectsNode(r));
  const out = [];
  for (const r of rows) {
    const full = S.paras[Number(r.dataset.i)] || '';
    // 逐行求「选区 ∩ 该行文字」：只在文字节点上量，行号徽标和提示文字不参与
    const textNodes = []; const walker = document.createTreeWalker(r, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement.closest('.gutter, .why') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) textNodes.push(n);
    let piece = '';
    for (const n of textNodes) {
      if (!range.intersectsNode(n)) continue;
      const from = n === range.startContainer ? range.startOffset : 0;
      const to = n === range.endContainer ? range.endOffset : n.data.length;
      piece += n.data.slice(from, to);
    }
    if (piece.trim()) out.push(piece);
    void full;
  }
  return out.length ? out : null;
}

function showSel(res, n) {
  let el = $('selbadge');
  if (!el) { el = document.createElement('div'); el.id = 'selbadge'; document.body.appendChild(el); }
  const unit = res.lang === 'en' ? '词' : '字';
  const val = countOf(res, res);
  el.innerHTML = `<div class="sb-n">${fmt(val)}<small>${unit}</small></div><div class="sb-l">已选 ${fmt(n)} 段 · ${modeText()}</div>
    <div class="sb-s">含场次头+人物行共 ${fmt(res.full)} ${unit} · 已排除外译与△</div><button class="sb-x" data-a="selclear" title="取消选择">×</button>`;
  el.classList.add('on');
}
function hideSel() { const el = $('selbadge'); if (el) el.classList.remove('on'); }

document.addEventListener('selectionchange', () => {
  clearTimeout(selTimer);
  selTimer = setTimeout(async () => {
    const paras = selectedParas();
    if (!paras || !S.res) return hideSel();
    const my = ++selSeq;
    try {
      const lang = S.res.analysis ? S.res.analysis.lang : (/[㐀-鿿]/.test(paras.join('')) ? 'zh' : 'en');
      const r = await (await postJSON('/api/count', { paragraphs: paras, lang })).json();
      if (my === selSeq && selectedParas()) showSel({ ...r, lang }, r.paragraphs);
    } catch { /* 忽略 */ }
  }, 180);
});
document.addEventListener('click', (e) => { if (e.target.closest('[data-a="mcclose"]')) { const m = $('manualcopy'); if (m) m.hidden = true; } const b = e.target.closest('[data-a="selclear"]'); if (b) { window.getSelection().removeAllRanges(); hideSel(); } });

refreshBooks();
render();
