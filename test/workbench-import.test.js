"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const createReceiver = require('../public/workbench-import.js');
const ORIGIN = 'http://127.0.0.1:6985';
const PRODUCTION_ORIGIN = 'https://inner-drama.storyplay.cn';
const NONCE = '1'.repeat(32);
const envelope = (type, detail = {}, nonce = NONCE) => ({ channel: 'storyplay-word-handoff', version: 1, nonce, type, ...detail });
const word = () => new Uint8Array([0x50, 0x4b, 3, 4, 1, 2]).buffer;
function setup(existing = 0) {
  const sent = []; const added = []; const changes = []; const errors = []; const listeners = new Map();
  const opener = { closed: false, postMessage: (message, origin) => sent.push({ message, origin }) };
  const window = { opener, crypto: webcrypto, File, addEventListener: (kind, listener) => listeners.set(kind, listener), removeEventListener: (kind, listener) => { if (listeners.get(kind) === listener) listeners.delete(kind); } };
  const receiver = createReceiver({ window, existingCount: () => existing + added.length,
    addFile: (file) => { const b = { file, status: 'running', stage: '正在校验与统计' }; added.push(b); return b; },
    getProgress: (b) => ({ status: b.status, stage: b.stage, ...(b.error ? { error: b.error } : {}) }),
    onChange: (snapshot) => changes.push(snapshot), onError: (error) => errors.push(error),
  });
  const send = (message, origin = ORIGIN, source = opener) => listeners.get('message')?.({ data: message, origin, source });
  const begin = (items = [{ id: 'p-one', name: '第一本.docx' }], nonce = NONCE) => send(envelope('begin', { items }, nonce));
  const file = (detail = {}, nonce = NONCE) => send(envelope('file', { id: 'p-one', name: '第一本.docx', size: 6, buffer: word(), ...detail }, nonce));
  return { receiver, send, begin, file, sent, added, changes, errors, opener, listeners };
}

test('握手只回应精确白名单与打开本页的窗口，返回页面实例', () => {
  const t = setup();
  for (const [message, origin, source] of [
    [envelope('hello'), 'http://127.0.0.1:6985.evil.invalid', t.opener],
    [envelope('hello'), 'https://inner-drama.storyplay.cn.evil.invalid', t.opener],
    [envelope('hello'), 'http://inner-drama.storyplay.cn', t.opener],
    [envelope('hello'), 'https://inner-drama.storyplay.cn:8443', t.opener],
    [envelope('hello'), ORIGIN, { postMessage() { throw Error('must not reply'); } }],
    [envelope('hello', {}, 'short'), ORIGIN, t.opener],
    [{ ...envelope('hello'), version: 2 }, ORIGIN, t.opener],
    [{ ...envelope('hello'), channel: 'other' }, ORIGIN, t.opener],
  ]) t.send(message, origin, source);
  assert.equal(t.sent.length, 0);
  t.send(envelope('hello'));
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].origin, ORIGIN);
  assert.equal(t.sent[0].message.type, 'ready');
  assert.match(t.sent[0].message.instance, /^[a-f0-9]{32}$/);
  assert.equal(t.receiver.snapshot(), null);
});

test('公网工作台可握手、提交清单和接收 Word，回执发回精确来源', () => {
  const t = setup();
  const send = (type, detail) => t.send(envelope(type, detail), PRODUCTION_ORIGIN);
  send('hello');
  assert.equal(t.sent.at(-1)?.message.type, 'ready');
  send('begin', { items: [{ id: 'p-one', name: '第一本.docx' }] });
  assert.equal(t.sent.at(-1).message.type, 'accept');
  send('file', { id: 'p-one', name: '第一本.docx', size: 6, buffer: word() });
  assert.equal(t.added.length, 1);
  assert.equal(t.receiver.snapshot().received, 1);
  assert.deepEqual(t.sent.map(({ message }) => message.type), ['ready', 'accept', 'ack', 'progress']);
  assert.ok(t.sent.every(({ origin }) => origin === PRODUCTION_ORIGIN));
});

test('清单最多100本，重复begin幂等，名额包含已存在的手工上传', () => {
  const t = setup(); const items = Array.from({ length: 100 }, (_, i) => ({ id: 'p-' + i, name: '剧本' + i + '.docx' }));
  t.begin(items);
  assert.equal(t.sent.at(-1).message.type, 'accept');
  assert.equal(t.receiver.reservedCount(), 100);
  t.begin(items);
  assert.equal(t.sent.at(-1).message.type, 'accept');
  assert.equal(t.changes.length, 1);
  t.begin([{ id: 'changed', name: '修改.docx' }]);
  assert.equal(t.sent.at(-1).message.type, 'error');
  assert.equal(t.receiver.snapshot().total, 100);
  const over = setup(); over.begin([...items, { id: 'p-100', name: '多一本.docx' }]);
  assert.equal(over.receiver.snapshot(), null);
  assert.equal(over.sent.at(-1).message.type, 'error');
  const occupied = setup(1); occupied.begin(items);
  assert.equal(occupied.receiver.snapshot(), null);
  assert.match(occupied.sent.at(-1).message.error, /先移除/);
});

test('100本交接入队即ACK，重复文件不占第二个名额，排队结果继续回传', () => {
  const t = setup();
  const items = Array.from({length:100}, (_, i) => ({id:'p-'+i,name:'剧本'+i+'.docx'}));
  t.begin(items);
  for (const item of items) {
    const payload = {id:item.id,name:item.name,size:6,buffer:word()};
    t.file(payload);
    t.file({...payload,buffer:word()});
  }
  assert.equal(t.added.length,100);
  assert.equal(t.receiver.reservedCount(),0);
  assert.equal(t.receiver.snapshot().received,100);
  assert.equal(t.sent.filter(x=>x.message.type==='ack').length,200);
  for(const book of t.added) {book.status='done';book.stage='统计完成';t.receiver.bookChanged(book);}
  assert.ok(t.receiver.snapshot().items.every(item=>item.status==='done'));
});

test('清单拒绝重复ID、非Word、路径名以及不合法大小', () => {
  for (const items of [
    [{ id: 'same', name: '甲.docx' }, { id: 'same', name: '乙.docx' }],
    [{ id: 'p', name: '甲.txt' }], [{ id: '../p', name: '甲.docx' }],
    [{ id: 'p', name: '../甲.docx' }], [{ id: 'p', name: '甲.docx', size: 0 }],
    [{ id: 'p', name: '甲.docx', size: 30 * 1024 * 1024 + 1 }],
  ]) { const t = setup(); t.begin(items); assert.equal(t.receiver.snapshot(), null); assert.equal(t.sent.at(-1).message.type, 'error'); }
});

test('逐本接收已准备的Word，失败重试，重复ACK不重复加入列表', () => {
  const t = setup(); t.begin([{ id: 'p-one', name: '第一本.docx' }, { id: 'p-two', name: '第二本.docx', size: 6 }]);
  for (const bad of [
    { name: '错名.docx' }, { size: 5 }, { buffer: new Uint8Array([1, 2, 3, 4, 5, 6]).buffer },
    { buffer: 'not bytes' }, { id: 'not-in-list' },
  ]) { t.file(bad); assert.equal(t.sent.at(-1).message.type, 'error'); }
  assert.equal(t.added.length, 0);
  t.file();
  assert.equal(t.added.length, 1);
  assert.equal(t.added[0].file.name, '第一本.docx');
  assert.equal(t.added[0].file.size, 6);
  assert.equal(t.receiver.snapshot().received, 1);
  assert.equal(t.receiver.reservedCount(), 1);
  assert.deepEqual(t.sent.slice(-2).map((x) => x.message.type), ['ack', 'progress']);
  // 传输确认丢失时，仅凭相同ID再次确认，文件不会重复添加。
  t.send(envelope('file', { id: 'p-one' }));
  assert.equal(t.added.length, 1);
  assert.deepEqual(t.sent.slice(-2).map((x) => x.message.type), ['ack', 'progress']);
  t.file({ id: 'p-two', name: '第二本.docx' });
  assert.equal(t.added.length, 2);
  assert.equal(t.receiver.reservedCount(), 0);
});

test('实际统计进度回传；Word准备失败不阻断其他文件，可在本次页面重试', () => {
  const t = setup(); t.begin([{ id: 'p-one', name: '第一本.docx' }, { id: 'p-two', name: '第二本.docx' }]);
  t.file();
  t.added[0].status = 'done'; t.added[0].stage = '统计完成';
  t.receiver.bookChanged(t.added[0]);
  assert.deepEqual(t.sent.at(-1).message, envelope('progress', { id: 'p-one', status: 'done', stage: '统计完成' }));
  t.send(envelope('error', { id: 'p-two', error: 'Word准备失败' }));
  assert.equal(t.receiver.snapshot().items[1].status, 'error');
  t.send(envelope('complete'));
  assert.equal(t.receiver.reservedCount(), 0);
  t.file({ id: 'p-two', name: '第二本.docx' });
  assert.equal(t.receiver.snapshot().received, 2);
  assert.equal(t.receiver.snapshot().items[1].status, 'running');
  t.added[1].status = 'error'; t.added[1].stage = '格式需调整'; t.added[1].error = '请修改集号';
  t.receiver.bookChanged(t.added[1]);
  assert.equal(t.sent.at(-1).message.error, '请修改集号');
  t.added[1].status = 'done'; t.added[1].stage = '统计完成'; delete t.added[1].error;
  t.receiver.bookChanged(t.added[1]);
  assert.equal(t.sent.at(-1).message.status, 'done');
});

test('页面实例变化可识别刷新，销毁后不再收发消息', () => {
  const a = setup(); const b = setup();
  a.send(envelope('hello')); b.send(envelope('hello'));
  assert.notEqual(a.sent[0].message.instance, b.sent[0].message.instance);
  a.begin(); a.file();
  a.added[0].importRemoved = true; a.receiver.bookChanged(a.added[0]);
  assert.equal(a.sent.at(-1).message.stage, '已从统计页移除');
  const before = a.sent.length;
  a.receiver.destroy(); a.send(envelope('hello'));
  assert.equal(a.sent.length, before);
  assert.equal(a.listeners.size, 0);
  assert.equal(a.receiver.snapshot(), null);
});
