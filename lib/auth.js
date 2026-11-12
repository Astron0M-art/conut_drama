// 登录与会话：账号校验、签名会话令牌、登录失败限流（零依赖）
'use strict';

const crypto = require('crypto');

const sha = (s) => crypto.createHash('sha256').update(String(s ?? '')).digest();
// 先哈希再比较：长度固定、不泄露长度，也不会因为提前返回泄露是哪一位不同
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

function createAuth({ credentials = '', secret = '', now = Date.now } = {}) {
  const enabled = credentials !== '';
  const i = credentials.indexOf(':');
  const user = i < 0 ? credentials : credentials.slice(0, i);
  const pass = i < 0 ? '' : credentials.slice(i + 1);
  if (enabled && (!user || !pass)) throw new Error('AUTH 格式应为「用户名:密码」，两部分都不能为空');

  // 签名密钥 = HMAC(SESSION_SECRET, 账号:密码)：改了密码，旧会话自动失效；
  // 没配 SESSION_SECRET 时每次启动随机生成（重启后需要重新登录）
  const key = crypto.createHmac('sha256', secret || crypto.randomBytes(32)).update(credentials).digest();
  const mac = (body) => crypto.createHmac('sha256', key).update(body).digest('base64url');

  return {
    enabled,
    user,
    check(u, p) {
      // JSON 请求中的对象不能交给 String()：自带 toString 属性时可能直接抛错。
      if (!enabled || typeof u !== 'string' || typeof p !== 'string') return false;
      const okUser = safeEqual(u, user);
      const okPass = safeEqual(p, pass);
      return okUser && okPass;
    },
    sign(ttlSec) {
      const body = Buffer.from(JSON.stringify({ u: user, exp: Math.floor(now() / 1000) + ttlSec })).toString('base64url');
      return `${body}.${mac(body)}`;
    },
    // 令牌有效返回账号名，否则返回 null
    verify(token) {
      if (typeof token !== 'string') return null;
      const parts = token.split('.');
      if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
      const [body, sig] = parts;
      // 只接受签发时使用的 base64url；字符长度相同不代表 UTF-8 字节长度相同。
      if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return null;
      const got = Buffer.from(sig);
      const want = Buffer.from(mac(body));
      if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
      try {
        const p = JSON.parse(Buffer.from(body, 'base64url').toString());
        return p.u === user && p.exp > now() / 1000 ? user : null;
      } catch {
        return null;
      }
    },
  };
}

// 登录失败限流：同一来源在窗口期内失败 max 次后，锁定到窗口结束；登录成功清零
class Throttle {
  constructor({ max = 5, windowMs = 15 * 60 * 1000, now = Date.now } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();
  }

  // 还要等多少秒才能再试，0 表示可以尝试
  wait(key) {
    const h = this.hits.get(key);
    if (!h) return 0;
    const left = h.first + this.windowMs - this.now();
    if (left <= 0) {
      this.hits.delete(key);
      return 0;
    }
    return h.count >= this.max ? Math.ceil(left / 1000) : 0;
  }

  fail(key) {
    const t = this.now();
    const h = this.hits.get(key);
    if (h && t < h.first + this.windowMs) h.count++;
    else this.hits.set(key, { count: 1, first: t });
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (t >= v.first + this.windowMs) this.hits.delete(k);
  }

  ok(key) {
    this.hits.delete(key);
  }
}

module.exports = { createAuth, Throttle };
