// 工作线程：在独立线程里解析，避免多文件并发时阻塞主线程
'use strict';

const { parentPort } = require('worker_threads');
const { analyzeBuffer, analyzeWithFormat } = require('./analyze');
const { validateBuffer } = require('./format');

parentPort.on('message', ({ id, buf, name, op }) => {
  try {
    parentPort.postMessage({ id, result: (op === 'validate' ? validateBuffer : op === 'analyzeFormat' ? analyzeWithFormat : analyzeBuffer)(Buffer.from(buf), name) });
  } catch (e) {
    parentPort.postMessage({ id, error: e.message || String(e) });
  }
});
