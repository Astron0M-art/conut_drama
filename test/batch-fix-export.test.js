'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { readParagraphs } = require('../lib/format');
const zip = require('../lib/format/zip');

let child; let base; let cookie;
before(async () => {
  child = spawn(process.execPath, [path.join(__dirname, '../server.js')], {
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', AUTH: 'batch:test', SESSION_SECRET: 'batch-secret' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  base = await new Promise((resolve, reject) => {
    let out = ''; const timer = setTimeout(() => reject(new Error('批量修复测试服务启动超时')), 8000);
    child.stdout.on('data', (chunk) => { out += chunk; const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out); if (m) { clearTimeout(timer); resolve(`http://127.0.0.1:${m[1]}`); } });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`批量修复测试服务提前退出 (${code})`)); });
  });
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'batch', password: 'test' }) });
  assert.equal(login.status, 200); cookie = login.headers.get('set-cookie').split(';')[0];
});
after(() => child?.kill());

const ref = readParagraphs(fs.readFileSync(path.join(__dirname, 'fixtures/reference.docx')), '.docx');
const body = ref.findIndex((x) => /^正文内容$/.test(x));
const broken = () => { const p = ref.slice(); p.splice(body + 4, 0, '△模型备注 \\<note>请删除这段内部内容\\</note>。'); return p; };
const post = (url, body) => fetch(base + url, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('批量修复最多100本并删除正文尖括号内容，批量导出返回ZIP', async () => {
  const response = await post('/api/fix-batch', { books: [{ id: 1, name: '带问题', paragraphs: broken() }, { id: 2, name: '无问题', paragraphs: ref }] });
  assert.equal(response.status, 200);
  const fixed = await response.json();
  assert.equal(fixed.total, 2);
  assert.equal(fixed.changed, 1);
  assert.ok(fixed.applied >= 1);
  assert.equal(fixed.books[0].angleRemoved, 1);
  assert.ok(fixed.books[0].paragraphs.every((x) => !x.includes('<note>')));
  assert.equal(fixed.books[0].format.ok, true);

  const exported = await post('/api/export-batch', { books: fixed.books.map((b) => ({ id: b.id, name: b.name, paragraphs: b.paragraphs })) });
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-type'), /application\/zip/);
  const files = zip.readAll(Buffer.from(await exported.arrayBuffer()));
  assert.equal(files.size, 2);
  assert.ok(files.has('带问题_标准格式.docx'));
  assert.ok(files.has('无问题_标准格式.docx'));
});

test('批量处理拒绝101本', async () => {
  const books = Array.from({ length: 101 }, (_, i) => ({ id: i, name: `剧本${i}`, paragraphs: ref }));
  const response = await post('/api/fix-batch', { books });
  assert.equal(response.status, 400);
});
