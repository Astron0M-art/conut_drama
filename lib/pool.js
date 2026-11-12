// 固定大小的 worker 线程池：任务排队、超时回收、崩溃重建
'use strict';

const { Worker } = require('worker_threads');
const path = require('path');

const WORKER_FILE = path.join(__dirname, 'worker.js');

class Pool {
  constructor(size, { timeoutMs = 20000 } = {}) {
    this.size = size;
    this.timeoutMs = timeoutMs;
    this.queue = [];
    this.idle = [];
    this.live = 0;
    this.nextId = 1;
  }

  get pending() {
    return this.queue.length + (this.live - this.idle.length);
  }

  run(buf, name) {
    return new Promise((resolve, reject) => {
      this.queue.push({ buf, name, resolve, reject });
      this._drain();
    });
  }

  _spawn() {
    const w = new Worker(WORKER_FILE);
    this.live++;
    w.on('error', () => {}); // 具体处理见 exit / 超时
    w.on('exit', () => {
      this.live--;
      this.idle = this.idle.filter((x) => x !== w);
      if (w.job) { w.job.reject(Object.assign(new Error('解析进程异常退出'), { status: 500 })); w.job = null; }
      this._drain();
    });
    return w;
  }

  _drain() {
    while (this.queue.length) {
      let w = this.idle.pop();
      if (!w && this.live < this.size) w = this._spawn();
      if (!w) return;
      this._dispatch(w, this.queue.shift());
    }
  }

  _dispatch(w, job) {
    const id = this.nextId++;
    w.job = job;
    const timer = setTimeout(() => {
      job.reject(Object.assign(new Error('解析超时'), { status: 500 }));
      w.job = null;
      w.terminate();
    }, this.timeoutMs);

    const onMsg = (msg) => {
      if (msg.id !== id) return;
      clearTimeout(timer);
      w.off('message', onMsg);
      w.job = null;
      this.idle.push(w);
      if (msg.error) job.reject(new Error(msg.error));
      else job.resolve(msg.result);
      this._drain();
    };
    w.on('message', onMsg);
    w.postMessage({ id, buf: job.buf, name: job.name });
  }
}

module.exports = { Pool };
