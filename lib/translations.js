'use strict';

// 标签是翻译标记的一部分，不能因为“西/英/法语”等汉字而保留整块译文。
const FOREIGN_LABEL = /^(?:(?:西(?:班牙)?|英|法|德|俄|日|韩|葡(?:萄牙)?|意(?:大利)?|阿拉伯|泰|越(?:南)?|印(?:地|尼)?|土耳其|马来|荷兰|希腊|波兰|瑞典)(?:语|文)?(?:翻译|译文)?|外语|外文|Spanish|English|French|German|Russian|Japanese|Korean|Portuguese|Arabic|Thai)\s*[:：]/iu;
const GENERIC_LABEL = /^(?:翻译|译文|译|translation|trans)\s*[:：]\s*/iu;
const CHINESE_LABEL = /^(?:中|中文|汉语|国语)\s*[:：]/u;
const PRODUCTION_TAG = /^(?:O\.?S\.?|V\.?O\.?|POV|SFX|BGM|CEO|CFO|COO|CTO|[A-Z]{1,4}\d{1,5})$/iu;
const HAN = /\p{Script=Han}/u;
const LETTER = /\p{L}/u;
const NON_CHINESE_SCRIPT = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Thai}\p{Script=Devanagari}]/u;

function looksLikeMixedTranslation(payload) {
  const latinWords = payload.match(/\p{Script=Latin}+(?:['’-]\p{Script=Latin}+)*/gu) || [];
  const latinChars = (payload.match(/\p{Script=Latin}/gu) || []).length;
  const hanChars = (payload.match(/\p{Script=Han}/gu) || []).length;
  // 翻译里偶尔会夹带一两个中文集名/角色名。只要拉丁文已经形成完整句子，
  // 且明显占主体，就不能因为这几个汉字把整块外译算进去。
  return latinWords.length >= 2 && latinChars >= 8 && latinChars >= hanChars * 3;
}

function isTranslation(inner, labelledOnly) {
  const value = inner.trim();
  if (FOREIGN_LABEL.test(value)) return true;
  if (CHINESE_LABEL.test(value) || PRODUCTION_TAG.test(value)) return false;
  const payload = value.replace(GENERIC_LABEL, '');
  const hasGenericLabel = payload !== value;
  if (labelledOnly && !hasGenericLabel) return false;
  // 没有明确外语标签时优先保护中文动作，即使其中夹杂日/韩等文字的人名；
  // 但拉丁文占主体的完整翻译句可能夹带中文名/集数，仍应整块剔除。
  if (HAN.test(payload)) return looksLikeMixedTranslation(payload) ? true : false;
  if (NON_CHINESE_SCRIPT.test(payload)) return true;
  // 中文动作和人物说明（例如“看向Jack”）保留；纯外语短句也剔除，
  // 不能因 No. / Dos. / 人名译文太短而漏掉。
  return LETTER.test(payload);
}

function stripTranslations(text, { labelledOnly = false } = {}) {
  const stack = [], spans = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '（') stack.push(i);
    else if ((ch === ')' || ch === '）') && stack.length) {
      const start = stack.pop();
      if (isTranslation(text.slice(start + 1, i), labelledOnly)) spans.push([start, i + 1]);
    }
  }
  // 合并外层/内层区间，避免嵌套翻译留下括号碎片。
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = [];
  for (const span of spans) {
    const previous = merged[merged.length - 1];
    if (previous && span[0] <= previous[1]) previous[1] = Math.max(previous[1], span[1]);
    else merged.push(span.slice());
  }
  let result = '', position = 0;
  for (const [start, end] of merged) {
    result += text.slice(position, start);
    // 保留段落位置，跨段翻译中的假“第N集/3-1”不会参与分集。
    result += text.slice(start, end).replace(/[^\n]/g, '');
    position = end;
  }
  return result + text.slice(position);
}

function stripTranslationParagraphs(paras, options) {
  return stripTranslations(paras.join('\n'), options).split('\n');
}

module.exports = { stripTranslations, stripTranslationParagraphs };
