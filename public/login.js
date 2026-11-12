'use strict';

const $ = (id) => document.getElementById(id);
const form = $('form'), user = $('user'), pass = $('pass'), go = $('go'), goText = $('goText');
const err = $('err'), card = $('card'), stamp = $('stamp'), caps = $('caps'), eye = $('eye');

// localStorage 在隐私模式等场景可能抛错，只当作可有可无的便利（记住上次的用户名）
const saved = {
  get() { try { return localStorage.getItem('cd_user') || ''; } catch { return ''; } },
  set(v) { try { localStorage.setItem('cd_user', v); } catch { /* 忽略 */ } },
};

const retrigger = (el, cls) => { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); };

function show(msg, info = false) {
  err.textContent = msg;
  err.className = info ? 'msg info' : 'msg';
  err.hidden = false;
}

// 盖章：失败盖红色「打回」，成功盖绿色「通过」
function slam(text, ok = false) {
  stamp.firstElementChild.textContent = text;
  stamp.classList.toggle('pass', ok);
  stamp.style.animation = 'none';
  void stamp.offsetWidth;
  stamp.style.animation = '';
}

function busy(on) {
  go.disabled = on;
  go.classList.toggle('busy', on);
  goText.textContent = on ? '验证中' : '登录';
}

// 被限流：按钮锁定并倒计时
let lockTimer = 0;
function lock(seconds) {
  clearInterval(lockTimer);
  let left = seconds;
  go.disabled = true;
  const tick = () => {
    if (left <= 0) {
      clearInterval(lockTimer);
      go.disabled = false;
      err.hidden = true;
      return;
    }
    show(`尝试次数过多，请 ${left > 90 ? Math.ceil(left / 60) + ' 分钟' : left + ' 秒'}后再试`);
    left--;
  };
  tick();
  lockTimer = setInterval(tick, 1000);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (go.disabled) return;

  const username = user.value.trim();
  const password = pass.value;
  if (!username || !password) {
    show(username ? '请输入密码' : '请输入用户名');
    (username ? pass : user).focus();
    return retrigger(card, 'shake');
  }

  busy(true);
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, remember: $('remember').checked }),
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok) {
      saved.set(username);
      err.hidden = true;
      slam('通过', true);
      goText.textContent = '已通过';
      setTimeout(() => location.replace('/'), 700); // 按钮保持禁用，等盖完章再跳转
      return;
    }

    busy(false);
    slam('打回');
    retrigger(card, 'shake');
    if (res.status === 429) return lock(Number(res.headers.get('Retry-After')) || 60);
    show(data.error || '登录失败，请重试');
    pass.focus();
    pass.select();
  } catch {
    busy(false);
    show('无法连接服务器，请检查网络后重试');
  }
});

for (const t of ['keydown', 'keyup']) {
  pass.addEventListener(t, (e) => { caps.hidden = !(e.getModifierState && e.getModifierState('CapsLock')); });
}
pass.addEventListener('blur', () => { caps.hidden = true; });

eye.addEventListener('click', () => {
  const reveal = pass.type === 'password';
  pass.type = reveal ? 'text' : 'password';
  eye.classList.toggle('revealed', reveal);
  eye.setAttribute('aria-pressed', String(reveal));
  eye.setAttribute('aria-label', reveal ? '隐藏密码' : '显示密码');
  pass.focus();
});

if (new URLSearchParams(location.search).has('expired')) show('登录已过期，请重新登录', true);
const last = saved.get();
if (last) { user.value = last; pass.focus(); } else user.focus();
