/* 当前页面的 Word 交接；只接受指定工作台及打开本页的窗口，不保存剧本。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.createWorkbenchReceiver = factory;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createWorkbenchReceiver(options) {
  'use strict';
  const win = options.window;
  const MAX = options.maxBooks || 20;
  const MAX_FILE = 30 * 1024 * 1024;
  const CHANNEL = 'storyplay-word-handoff';
  const origins = new Set(options.origins || [
    'http://127.0.0.1:6985', 'http://localhost:6985',
    'http://127.0.0.1:6986', 'http://localhost:6986', 'http://82.157.198.44:8888',
  ]);
  const random = new Uint8Array(16);
  win.crypto.getRandomValues(random);
  const instance = Array.from(random, (b) => b.toString(16).padStart(2, '0')).join('');
  let session = null;
  let stopped = false;
  const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
  const validName = (name) => typeof name === 'string' && name.length <= 250 && !/[\\/\0]/.test(name) && /\.docx$/i.test(name);
  const validSize = (size) => Number.isSafeInteger(size) && size > 0 && size <= MAX_FILE;
  const text = (value) => String(value || '交接失败').slice(0, 400);
  function post(source, origin, nonce, type, detail = {}) {
    if (stopped || source.closed) return;
    try { source.postMessage({ channel: CHANNEL, version: 1, nonce, type, ...detail }, origin); } catch { /* 原窗口已关闭 */ }
  }
  function snapshot() {
    if (!session) return null;
    return { total: session.items.size, received: session.received.size, sourceComplete: session.complete,
      items: Array.from(session.items, ([id, item]) => ({ id, name: item.name,
        ...(session.received.has(id) ? progress(session.received.get(id)) : { status: item.error ? 'error' : 'queued', stage: item.error ? 'Word 准备失败' : '等待 Word 准备', ...(item.error ? { error: item.error } : {}) }),
      })) };
  }
  function changed() { if (options.onChange) options.onChange(snapshot()); }
  function progress(book) {
    if (book.importRemoved) return { status: 'error', stage: '已从统计页移除', error: '剧本已从统计页移除' };
    return options.getProgress(book);
  }
  function report(id, book) {
    post(session.source, session.origin, session.nonce, 'progress', { id, ...progress(book) });
  }
  function invalid(event, data, error) {
    if (session && session.nonce === data.nonce && session.items.has(data.id) && !session.received.has(data.id)) {
      session.items.get(data.id).error = error;
      changed();
    }
    if (options.onError) options.onError(error);
    post(event.source, event.origin, data.nonce, 'error', { ...(validId(data.id) ? { id: data.id } : {}), error });
  }
  function onMessage(event) {
    const data = event.data;
    if (stopped || !win.opener || event.source !== win.opener || !origins.has(event.origin) || !data || typeof data !== 'object' ||
      data.channel !== CHANNEL || data.version !== 1 || typeof data.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(data.nonce)) return;
    if (data.type === 'hello') {
      post(event.source, event.origin, data.nonce, 'ready', { instance });
      return;
    }
    if (data.type === 'begin') {
      if (!Array.isArray(data.items) || !data.items.length || data.items.length > MAX || data.items.some((item) => !item || !validId(item.id) || !validName(item.name) || (item.size != null && !validSize(item.size))) || new Set(data.items.map((item) => item.id)).size !== data.items.length)
        return invalid(event, data, '一次只能导入 1–20 本 Word，每本最多 30MB');
      const manifest = JSON.stringify(data.items.map(({ id, name, size }) => ({ id, name, ...(size != null ? { size } : {}) })));
      if (session && session.nonce === data.nonce) {
        if (session.origin !== event.origin || session.source !== event.source) return invalid(event, data, '本次导入窗口已经改变，请重新发起导入');
        if (session.manifest !== manifest) return invalid(event, data, '本次导入清单已经确定，请重新发起导入');
        post(event.source, event.origin, data.nonce, 'accept', { instance });
        return;
      }
      if (options.existingCount() + data.items.length > MAX) return invalid(event, data, '统计页最多保留 20 本，请先移除已有剧本或重新打开统计页');
      session = { source: event.source, origin: event.origin, nonce: data.nonce, manifest,
        items: new Map(data.items.map((item) => [item.id, { name: item.name, ...(item.size != null ? { size: item.size } : {}) }])), received: new Map(), complete: false };
      changed();
      post(event.source, event.origin, data.nonce, 'accept', { instance });
      return;
    }
    if (!session || session.nonce !== data.nonce || session.source !== event.source || session.origin !== event.origin) return;
    if (data.type === 'file') {
      const item = session.items.get(data.id);
      if (!item) return invalid(event, data, '剧本不在本次导入清单中');
      // 接收确认可重发；同一项绝不重复加入列表。
      if (session.received.has(data.id)) {
        post(event.source, event.origin, data.nonce, 'ack', { id: data.id });
        report(data.id, session.received.get(data.id));
        return;
      }
      if (data.name !== item.name || !validSize(data.size) || (item.size != null && data.size !== item.size) || !(data.buffer instanceof ArrayBuffer) || data.buffer.byteLength !== data.size)
        return invalid(event, data, 'Word 文件名或大小与导入清单不一致');
      const bytes = new Uint8Array(data.buffer);
      if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04)
        return invalid(event, data, '收到的文件不是有效的 Word 文档');
      if (options.existingCount() >= MAX) return invalid(event, data, '统计页已满，请先移除已有剧本');
      try {
        const file = new win.File([data.buffer], item.name, { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
        const book = options.addFile(file);
        if (!book) throw new Error('Word 没有加入统计列表，请重新导入');
        delete item.error;
        session.received.set(data.id, book);
        post(event.source, event.origin, data.nonce, 'ack', { id: data.id });
        report(data.id, book);
        changed();
      } catch (error) { invalid(event, data, text(error.message)); }
    } else if (data.type === 'complete') {
      session.complete = true;
      changed();
    } else if (data.type === 'error' && session.items.has(data.id) && !session.received.has(data.id)) {
      session.items.get(data.id).error = text(data.error);
      changed();
    }
  }
  function bookChanged(book) {
    if (!session) return;
    for (const [id, candidate] of session.received) if (candidate === book) report(id, book);
    changed();
  }
  function reservedCount() {
    return session && !session.complete ? session.items.size - session.received.size : 0;
  }
  function destroy() { stopped = true; session = null; win.removeEventListener('message', onMessage); }
  win.addEventListener('message', onMessage);
  return { bookChanged, reservedCount, snapshot, destroy };
});
