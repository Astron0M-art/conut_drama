'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const AuditSummary = require('../public/audit-summary');

const source = fs.readFileSync(path.join(__dirname, '../public/type.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/type.html'), 'utf8');

function harness(fetchRequest = async () => new Response('{}')) {
  const elements = new Map();
  const listeners = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      id, hidden: false, innerHTML: '', textContent: '', style: {}, value: '', dataset: {},
      clientWidth: 900, clientHeight: 500, offsetHeight: 500, scrollTop: 0,
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute(name, value) { this[name] = value; },
      addEventListener() {}, scrollIntoView() {}, focus() {}, scrollTo() {}, click() {},
      getBoundingClientRect: () => ({ top: 0, height: 500 }),
      querySelector: (selector) => element(selector),
    });
    return elements.get(id);
  }
  const document = {
    getElementById: element,
    querySelector: element,
    querySelectorAll: () => [],
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(listener); },
  };
  const context = vm.createContext({
    document, AuditSummary, Response, URL, console,
    window: { addEventListener() {}, getSelection: () => ({ toString: () => '', isCollapsed: true }), confirm: () => true },
    location: {}, innerWidth: 1000, navigator: {},
    setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame() {},
    createWorkbenchReceiver: () => ({ reservedCount: () => 0, bookChanged() {}, destroy() {} }),
    fetch: (url, options) => url === '/api/me' ? Promise.resolve(new Response('{}')) : fetchRequest(url, options),
  });
  vm.runInContext(`${source}\nglobalThis.app = { books, S, select, showStep, checkBook, addFiles, validateOne, summaryData, current: () => cur };`, context);
  return {
    ...context.app, element,
    dispatch(type, target) { for (const fn of listeners.get(type) || []) fn({ target, stopPropagation() {} }); },
  };
}

function result(text = '甲：你好。', count = 700) {
  return {
    name: text, paragraphs: [text], marks: {},
    format: { ok: true, errors: 0, warns: 0, fixable: 0, issues: [], blocks: [{ para: 0, text, kind: 'dialog', issues: [] }] },
    analysis: { lang: 'zh', issues: [], episodes: [{ no: 1, scenes: 1, counts: { pure: count }, parts: { scene: 8, cast: 3 } }] },
  };
}

function book(id, text) {
  const res = result(text);
  return { id, name: text, file: { name: `${text}.docx`, size: 100 }, status: 'done', revision: 0, requestVersion: 0, dirty: false, rechecking: false, paras: res.paragraphs.slice(), res };
}

test('三步是真实视图切换，统一说明与统计口径不重复', () => {
  const h = harness();
  h.showStep(3);
  assert.equal(h.element('allStats').hidden, false);
  assert.equal(h.element('stage').hidden, true);
  assert.equal(h.element('formatOverview').hidden, true);
  h.showStep(1);
  assert.equal(h.element('allStats').hidden, true);
  assert.equal(h.element('formatOverview').hidden, false);
  assert.equal((html.match(/id="guideCard"/g) || []).length, 1);
  assert.equal((html.match(/id="incScene"/g) || []).length, 1);
  assert.equal((html.match(/id="min"/g) || []).length, 1);
  assert.doesNotMatch(html, /<footer>|id="hint"/);
  assert.match(html, /共可放入 100 本/);
});

test('A 本重新校验期间切换 B，本次返回只更新 A，不串当前文档', async () => {
  let resolve;
  const h = harness(() => new Promise((done) => { resolve = done; }));
  const a = book(1, '甲本'), b = book(2, '乙本');
  h.books.push(a, b); h.select(a);
  a.paras = ['修改后的甲本']; a.dirty = true; a.revision++;
  const pending = h.checkBook(a);
  assert.equal(h.summaryData().books[0].totalWords, null);
  h.select(b);
  resolve(new Response(JSON.stringify(result('修改后的甲本', 850))));
  await pending;
  assert.equal(a.res.analysis.episodes[0].counts.pure, 850);
  assert.equal(a.dirty, false);
  assert.equal(h.current(), b);
  assert.equal(h.S.name, '乙本');
  assert.equal(h.S.paras[0], '乙本');
  assert.equal(h.summaryData().books[0].totalWords, 850);
});

test('被移除剧本的自动修复响应不会更新其他书或重新加入列表', async () => {
  let resolve;
  const h = harness(() => new Promise((done) => { resolve = done; }));
  const a = book(1, '甲本'), b = book(2, '乙本');
  h.books.push(a, b); h.select(a);
  const pending = h.checkBook(a, true);
  h.books.splice(0, 1); h.select(b);
  resolve(new Response(JSON.stringify({ ...result('旧请求返回', 900), applied: 1 })));
  await pending;
  assert.equal(h.books.length, 1);
  assert.equal(h.current(), b);
  assert.equal(h.S.paras[0], '乙本');
  assert.equal(a.res.paragraphs[0], '甲本');
});

test('编辑草稿使旧汇总失效，取消后恢复；无效区间不破坏原统计', () => {
  const h = harness(); const a = book(1, '甲本');
  h.books.push(a); h.select(a);
  a.editDraft = { para: 0, text: '甲本', beforeDirty: false };
  h.dispatch('input', { id: 'ta', value: '已修改' });
  assert.equal(a.dirty, true);
  assert.equal(h.summaryData().books[0].totalWords, null);
  const cancel = { dataset: { a: 'cancel' } };
  h.dispatch('click', { closest: (selector) => selector === '[data-a]' ? cancel : null });
  assert.equal(a.dirty, false);
  assert.equal(h.summaryData().books[0].totalWords, 700);
  h.element('min').value = '10.5'; h.element('max').value = '5';
  h.dispatch('change', { id: 'min' });
  assert.equal(h.S.min, 550);
  assert.equal(h.S.max, 1000);
  assert.equal(h.summaryData().books[0].totalWords, 700);
});

test('一百本共享队列只发起两本并发校验，超容量不加入', () => {
  const requests = [];
  const h = harness((url) => { requests.push(url); return new Promise(() => {}); });
  h.addFiles(Array.from({ length: 102 }, (_, i) => ({ name: `剧本${i + 1}.docx`, size: 100 })));
  assert.equal(h.books.length, 100);
  assert.equal(requests.length, 2);
  assert.equal(h.books.filter((b) => b.status === 'running').length, 2);
  assert.equal(h.books.filter((b) => b.status === 'queued').length, 98);
});

test('未识别到正文集数不会显示全部合格', () => {
  const h = harness(); const a = book(1, '空集数');
  a.res.analysis.episodes = [];
  h.books.push(a); h.select(a); h.showStep(2);
  assert.match(h.element('count').innerHTML, /未识别到正文集数/);
  assert.doesNotMatch(h.element('count').innerHTML, /全部集数字数合格/);
  assert.equal(h.summaryData().books[0].passed, null);
});

test('只看问题行时保存修改，重校验中的正文仍可见', async () => {
  let resolve;
  const h = harness(() => new Promise((done) => { resolve = done; }));
  const a = book(1, '甲本');
  a.onlyBad = true;
  h.books.push(a); h.select(a);
  a.paras = ['修改后的正文']; a.dirty = true; a.revision++;
  const pending = h.checkBook(a);
  assert.equal(h.S.onlyBad, false);
  assert.match(h.element('paper').innerHTML, /修改后的正文/);
  resolve(new Response(JSON.stringify(result('修改后的正文'))));
  await pending;
});

test('全本异常默认三条，展开和收起时集号与字数两列保持对齐', () => {
  const h = harness(); const a = book(1, '多异常剧本');
  a.res.analysis.episodes = [100, 200, 300, 400, 1500].map((n, i) => ({
    no: i + 1, scenes: 1, counts: { pure: n }, parts: { scene: 0, cast: 0 },
  }));
  h.books.push(a); h.select(a); h.showStep(3);
  const content = () => h.element('allStats').innerHTML;
  assert.equal((content().match(/class="summary-line"/g) || []).length, 6);
  assert.match(content(), /展开其余 2 集/);
  assert.match(content(), /aria-expanded="false"/);
  assert.doesNotMatch(content(), /第4集|400 字/);
  const toggle = { dataset: { a: 'summary-toggle', id: '1' } };
  const click = () => h.dispatch('click', { closest: (selector) => selector === '[data-a]' ? toggle : null });
  click();
  assert.equal((content().match(/class="summary-line"/g) || []).length, 10);
  assert.match(content(), /第4集/);
  assert.match(content(), /400 字/);
  assert.match(content(), /aria-expanded="true"/);
  assert.match(content(), /收起明细/);
  assert.equal(h.summaryData().books[0].badEpisodes.length, 5, '展开状态不改变供 Excel 使用的完整汇总');
  click();
  assert.equal((content().match(/class="summary-line"/g) || []).length, 6);
  assert.doesNotMatch(content(), /第4集|400 字/);
});
