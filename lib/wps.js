// 字数算法：移植自 count_words.ts（精确匹配 WPS 规则）
//   汉字 / 全角符号 / 中文标点：每个算 1 字
//   英文单词（仅字母，可含内部 ' ’ -，长度 ≥ 2）：每个算 1 字
//   空白、数字、半角标点、单字母：不计
'use strict';

const CN_PUNCT = new Set('，。！？；：、（）【】《》「」『』“”‘’…—～·▲◆■●★☆※');

function isWhitespace(c) {
  return c <= 0x20 || c === 0xa0 || c === 0x3000;
}

function isChinese(c, ch) {
  return (
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0xff00 && c <= 0xffef) ||
    (c >= 0x3000 && c <= 0x303f) ||
    (c >= 0x25a0 && c <= 0x25ff) ||
    CN_PUNCT.has(ch)
  );
}

function isLetter(c) {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

function isWordChar(c) {
  return isLetter(c) || c === 0x27 || c === 0x2019 || c === 0x2d;
}

function countWords(text) {
  if (!text) return 0;
  let total = 0;
  let i = 0;
  const len = text.length;
  while (i < len) {
    const c = text.charCodeAt(i);
    if (isWhitespace(c)) i++;
    else if (isChinese(c, text[i])) { total++; i++; }
    else if (isLetter(c)) {
      const start = i;
      while (i < len && isWordChar(text.charCodeAt(i))) i++;
      if (i - start >= 2) total++;
    } else i++;
  }
  return total;
}

// 纯汉字数（中文剧本用）：只数汉字（含扩展区），中文标点、全角符号、英文、数字、空白都不算
const HAN_RE = /\p{Script=Han}/gu;

function countHan(text) {
  if (!text) return 0;
  const m = text.match(HAN_RE);
  return m ? m.length : 0;
}

// 英文单词数（英文剧本用）：连续的拉丁字母算 1 个词，可含内部撇号和连字符；
// 沿用上面 WPS 规则对英文词的约定：≥2 个字符才算，数字、标点不算
const EN_WORD_RE = /\p{Script=Latin}+(?:['’-]\p{Script=Latin}+)*/gu;

function countEnglish(text) {
  if (!text) return 0;
  let n = 0;
  for (const w of text.match(EN_WORD_RE) || []) if (w.length >= 2) n++;
  return n;
}

module.exports = { countWords, countHan, countEnglish };
