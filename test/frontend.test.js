'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { analyzeBuffer } = require('../lib/analyze');

test('实际分析结果能被页面汇总、明细及 CSV 消费', () => {
  const book = {
    id: 1, name: '合同回归', status: 'done',
    file: { name: '合同回归.txt', size: 100 },
    result: analyzeBuffer(Buffer.from('第1集\n你好，世界！\n'), '合同回归.txt'),
  };
  // 使用真实页面函数，避免接口测试通过、页面字段却已改名的回归。
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const context = vm.createContext({ book, innerWidth: 1024, document: { getElementById: () => ({ clientWidth: 900 }) } });
  vm.runInContext(source.slice(0, source.indexOf('/* ---------------- 事件')), context);
  vm.runInContext('state.books = [book]', context);
  assert.strictEqual(vm.runInContext('summarize(book).eps[0].n', context), 6);
  assert.match(vm.runInContext('bookHTML(book)', context), /按汉字计数/);
  assert.match(vm.runInContext('csvText()', context), /"汉字","6","6","偏少","544","6"/);
  vm.runInContext("state.caliber = 'pure'", context);
  assert.strictEqual(vm.runInContext('summarize(book).eps[0].n', context), 6);
});
