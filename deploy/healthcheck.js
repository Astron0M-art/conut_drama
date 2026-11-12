// 由 sudo 运行；凭据只在内存中使用，日志不输出密码或会话。
'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');

async function main() {
  const env = Object.fromEntries(fs.readFileSync('/etc/count-drama.env', 'utf8')
    .split(/\r?\n/).filter((line) => line && !line.startsWith('#')).map((line) => {
      const i = line.indexOf('=');
      return [line.slice(0, i), line.slice(i + 1)];
    }));
  const auth = env.AUTH || env.BASIC_AUTH || '';
  const sep = auth.indexOf(':');
  assert.ok(sep > 0 && sep < auth.length - 1, '服务器 AUTH 缺失或格式错误');
  assert.ok(env.SESSION_SECRET, '服务器 SESSION_SECRET 缺失');
  assert.ok(Number(env.PORT) > 0 && Number(env.PORT) <= 65535, '服务器 PORT 无效');
  if (process.argv.includes('--config-only')) {
    console.log('私有配置检查通过');
    return;
  }
  const host = ['0.0.0.0', '::', undefined].includes(env.HOST) ? '127.0.0.1' : env.HOST;
  const url = `http://${host}:${env.PORT}`;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const login = await fetch(`${url}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: auth.slice(0, sep), password: auth.slice(sep + 1) }),
        signal: AbortSignal.timeout(2000),
      });
      assert.equal(login.status, 200, '登录检查失败');
      const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
      assert.ok(cookie.startsWith('cd_session='), '未获得登录会话');
      const health = await fetch(`${url}/healthz`, {
        headers: { Cookie: cookie }, signal: AbortSignal.timeout(2000),
      });
      assert.equal(health.status, 200);
      assert.equal((await health.json()).ok, true);
      console.log('运行态登录及 /healthz 检查通过');
      return;
    } catch (error) {
      if (attempt === 19) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
