// 起一个真实的服务进程，走一遍：未登录拦截 → 登录 → 会话 → 分析 → 退出 → 限流
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'server.js');
let child;
let base;

before(async () => {
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', AUTH: 'admin:s3cret', SESSION_SECRET: 'test-secret' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  base = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('服务启动超时')), 8000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m) { clearTimeout(timer); resolve(`http://127.0.0.1:${m[1]}`); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`服务提前退出 (${code})：${out}`)); });
  });
});

after(() => child && child.kill());

const post = (p, body, headers = {}) =>
  fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const get = (p, cookie) => fetch(base + p, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
const cookieOf = (res) => res.headers.get('set-cookie').split(';')[0];

test('未登录：页面跳到登录页，接口与资源返回 401，登录页和它的样式脚本可以打开', async () => {
  const home = await get('/');
  assert.strictEqual(home.status, 302);
  assert.strictEqual(home.headers.get('location'), '/login');

  assert.strictEqual((await get('/app.js')).status, 401);
  assert.strictEqual((await get('/api/me')).status, 401);
  assert.strictEqual((await get('/healthz')).status, 401);
  assert.strictEqual((await post('/api/analyze', 'x', { 'X-Filename': 'a.txt' })).status, 401);

  const login = await get('/login');
  assert.strictEqual(login.status, 200);
  assert.match(await login.text(), /登录工作台/);
  assert.strictEqual((await get('/login.js')).status, 200);
  assert.strictEqual((await get('/login.css')).status, 200);
  assert.strictEqual((await get('/style.css')).status, 200);
});

test('登录：错误密码 401；正确密码发 HttpOnly 会话 Cookie，凭它能进工作台、分析文件、退出', async () => {
  assert.strictEqual((await post('/api/login', { username: 'admin', password: 'nope' })).status, 401);
  assert.strictEqual((await post('/api/login', '{bad json')).status, 400);

  const ok = await post('/api/login', { username: 'admin', password: 's3cret' });
  assert.strictEqual(ok.status, 200);
  const raw = ok.headers.get('set-cookie');
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /SameSite=Lax/);
  assert.doesNotMatch(raw, /Max-Age/); // 没勾「免登录」是会话 Cookie
  const cookie = cookieOf(ok);

  assert.strictEqual((await get('/', cookie)).status, 200);
  assert.strictEqual((await get('/login', cookie)).headers.get('location'), '/'); // 已登录不再看登录页
  assert.deepStrictEqual(await (await get('/api/me', cookie)).json(), { auth: true, user: 'admin' });

  const r = await fetch(base + '/api/analyze', { method: 'POST', headers: { Cookie: cookie, 'X-Filename': 'a.txt' }, body: '第1集\n△你好。\n' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await r.json()).episodes.length, 1);

  assert.strictEqual((await get('/', cookie.slice(0, -2) + 'xx')).status, 302); // 篡改签名

  const out = await post('/api/logout', {}, { Cookie: cookie });
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
});

test('恶意登录参数和非 ASCII Cookie 返回未授权，服务持续可用且正常账号能登录', async () => {
  for (const body of [
    { username: { toString: null }, password: 'x' },
    { username: 'admin', password: { toString: 0 } },
  ]) {
    assert.strictEqual((await post('/api/login', body)).status, 401);
    assert.strictEqual((await get('/login')).status, 200);
  }
  assert.strictEqual((await get('/api/me', `cd_session=e30.${'é'.repeat(43)}`)).status, 401);
  assert.strictEqual((await get('/login')).status, 200);
  assert.strictEqual(child.exitCode, null);

  const ok = await post('/api/login', { username: 'admin', password: 's3cret' });
  assert.strictEqual(ok.status, 200);
  const cookie = cookieOf(ok);
  assert.deepStrictEqual(await (await get('/api/me', cookie)).json(), { auth: true, user: 'admin' });
  assert.strictEqual((await get('/healthz', cookie)).status, 200);
});

test('勾选「30 天内免登录」发持久 Cookie', async () => {
  const res = await post('/api/login', { username: 'admin', password: 's3cret', remember: true });
  assert.match(res.headers.get('set-cookie'), /Max-Age=2592000/);
});

test('限流：连续输错 5 次后锁定，之后连正确密码也要等', async () => {
  await Promise.all(Array.from({ length: 5 }, () => post('/api/login', { username: 'admin', password: 'wrong' })));
  const locked = await post('/api/login', { username: 'admin', password: 's3cret' });
  assert.strictEqual(locked.status, 429);
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
});

test('监听公网地址却没设置 AUTH 时拒绝启动', () => {
  const r = spawnSync(process.execPath, [SERVER], {
    env: { ...process.env, HOST: '0.0.0.0', PORT: '0', AUTH: '', BASIC_AUTH: '' },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /AUTH/);
});
