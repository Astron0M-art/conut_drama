'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createAuth, Throttle } = require('../lib/auth');

test('账号校验：账号和密码都对才通过，密码里可以有冒号', () => {
  const a = createAuth({ credentials: 'admin:pa:ss', secret: 's' });
  assert.ok(a.check('admin', 'pa:ss'));
  assert.ok(!a.check('admin', 'pa'));
  assert.ok(!a.check('Admin', 'pa:ss'));
  assert.ok(!a.check(undefined, undefined));
  assert.ok(!a.check('admin', ['pa:ss'])); // 数组会被 String() 成 "pa:ss"，必须按类型拒绝
});

test('AUTH 格式不对直接报错；不设置则不启用', () => {
  assert.throws(() => createAuth({ credentials: 'admin' }), /AUTH/);
  assert.throws(() => createAuth({ credentials: ':x' }), /AUTH/);
  assert.throws(() => createAuth({ credentials: 'admin:' }), /AUTH/);
  assert.strictEqual(createAuth({}).enabled, false);
  assert.strictEqual(createAuth({}).check('', ''), false);
});

test('异常登录参数按未授权处理，不执行对象的字符串转换', () => {
  const a = createAuth({ credentials: 'admin:x', secret: 's' });
  for (const bad of [{ toString: null }, { toString: 0 }, null, 1, ['admin']]) {
    assert.strictEqual(a.check(bad, 'x'), false);
    assert.strictEqual(a.check('admin', bad), false);
  }
  assert.strictEqual(a.check('admin', 'x'), true);
});

test('会话令牌：往返校验；篡改、过期、改密码、换密钥都会失效', () => {
  let t = 1_700_000_000_000;
  const now = () => t;
  const a = createAuth({ credentials: 'admin:x', secret: 's', now });
  const tok = a.sign(60);
  assert.strictEqual(a.verify(tok), 'admin');

  const sig = tok.split('.')[1];
  const forged = Buffer.from(JSON.stringify({ u: 'admin', exp: 9e9 })).toString('base64url') + '.' + sig;
  for (const bad of [forged, tok + 'x', tok + '.y', '', 'abc', undefined, '.', 'a.b']) {
    assert.strictEqual(a.verify(bad), null, String(bad));
  }

  assert.strictEqual(createAuth({ credentials: 'admin:y', secret: 's', now }).verify(tok), null);
  assert.strictEqual(createAuth({ credentials: 'admin:x', secret: 'other', now }).verify(tok), null);

  t += 61_000;
  assert.strictEqual(a.verify(tok), null);
});

test('非 ASCII 或格式异常的会话签名安全拒绝，正常令牌仍有效', () => {
  const a = createAuth({ credentials: 'admin:x', secret: 's' });
  const token = a.sign(60);
  const [body, sig] = token.split('.');
  for (const bad of [
    `${body}.${'é'.repeat(43)}`,
    `${body}.${'!'.repeat(43)}`,
    `${body}.${sig.slice(1)}`,
    `é.${sig}`,
    { toString: null },
  ]) assert.strictEqual(a.verify(bad), null);
  assert.strictEqual(a.verify(token), 'admin');
});

test('限流：失败到上限后锁定，窗口过后恢复，成功清零，各来源互不影响', () => {
  let t = 0;
  const th = new Throttle({ max: 3, windowMs: 60_000, now: () => t });
  assert.strictEqual(th.wait('a'), 0);
  th.fail('a');
  th.fail('a');
  assert.strictEqual(th.wait('a'), 0);
  th.fail('a');
  assert.strictEqual(th.wait('a'), 60);
  assert.strictEqual(th.wait('b'), 0);

  t = 30_000;
  assert.strictEqual(th.wait('a'), 30);
  t = 60_000;
  assert.strictEqual(th.wait('a'), 0);

  th.fail('a');
  th.fail('a');
  th.ok('a');
  th.fail('a');
  th.fail('a');
  assert.strictEqual(th.wait('a'), 0);
});
