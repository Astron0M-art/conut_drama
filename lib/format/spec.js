// 标准格式定义：完全对照参考稿《我在宗门当锻造学徒，每一锤都在升级》.docx
'use strict';

const SECTIONS = ['synopsis', 'chars', 'rough', 'outline', 'body'];
const HEADING = { synopsis: '故事梗概', chars: '人物小传', rough: '分集大纲·粗纲', outline: '分集大纲·集纲', body: '正文内容' };

// 别名 → 小节。非标准写法会报错并提供一键改写
const ALIASES = {
  故事梗概: 'synopsis',
  人物小传: 'chars',
  '分集大纲·粗纲': 'rough', '分集大纲-粗纲': 'rough', '分集大纲・粗纲': 'rough', '分集大纲—粗纲': 'rough', 分集粗纲: 'rough', 粗纲: 'rough',
  '分集大纲·集纲': 'outline', '分集大纲-集纲': 'outline', '分集大纲・集纲': 'outline', '分集大纲—集纲': 'outline', 分集集纲: 'outline', 集纲: 'outline',
  分集大纲: 'outline', 分级大纲: 'outline', 分集梗概: 'outline', 分集概要: 'outline',
  正文内容: 'body', 剧本正文: 'body', 正文: 'body', 剧本内容: 'body', 剧本正文内容: 'body',
};

const SYNOPSIS_FIELDS = ['短剧类型', '目标受众', '题材类型', '核心设定', '风格元素', '世界观', '核心亮点', '核心梗概', '人物目标', '核心阻碍'];
const OPTIONAL_EMPTY = new Set(['人物目标']); // 参考稿中此项为空
const CHAR_FIELDS = ['姓名', '年龄', '定位', '性别', '性格', '背景', '外貌', '标志性动作', '随身物件与规则', '人物行动线'];
const ACTION_LINE_PARTS = ['起点', '目标', '关键选择', '代价', '变化'];

const CN = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function toNum(s) {
  s = String(s).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  let total = 0; let cur = 0;
  for (const ch of s) {
    if (ch === '百') { total += (cur || 1) * 100; cur = 0; } else if (ch === '十') { total += (cur || 1) * 10; cur = 0; } else cur = CN[ch] ?? cur;
  }
  return total + cur;
}

// 去掉 Markdown 标记 / 序号 / 括号 / 冒号后与别名比对
function headingKey(text) {
  const t = text.replace(/[​-‍﻿]/g, '').trim()
    .replace(/^#{1,6}\s*/, '').replace(/^(?:\*\*|__)([\s\S]*?)(?:\*\*|__)$/, '$1')
    .replace(/\s+/g, '')
    .replace(/^(?:[一二三四五六七八九十0-9]+[、.．]|[（(][一二三四五六七八九十0-9]+[）)])/, '')
    .replace(/^[【\[](.+)[】\]]$/, '$1').replace(/[：:]$/, '');
  return t.length <= 12 ? ALIASES[t] || '' : '';
}

const stageText = (name, a, b) => `${name}（第 ${a} – ${b} 集）`;

module.exports = { SECTIONS, HEADING, SYNOPSIS_FIELDS, OPTIONAL_EMPTY, CHAR_FIELDS, ACTION_LINE_PARTS, toNum, headingKey, stageText };
