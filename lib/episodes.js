// 分集 + 统计：输入段落数组，输出每集字数（三种口径）
'use strict';

const { countWords, countHan, countEnglish } = require('./wps');

const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function toNumber(s) {
  if (/^[0-9０-９]+$/.test(s)) return parseInt(s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)), 10);
  let total = 0;
  let cur = 0;
  for (const ch of s) {
    if (ch === '百') { total += (cur || 1) * 100; cur = 0; }
    else if (ch === '十') { total += (cur || 1) * 10; cur = 0; }
    else cur = CN_DIGIT[ch] ?? cur;
  }
  return total + cur;
}

// 「第12集」「第12集 标题」「第十二集：标题」
const HEAD_RE = /^第\s*([0-9０-９]+|[零〇一二两三四五六七八九十百]+)\s*集\s*(?:[：:、\-—·.．]?\s*(.*))?$/;
const SCENE_RE = /^\d+\s*-\s*\d+[\s　]/; // 1-1 夜 内 xxx
const CAST_RE = /^人物[:：]/;
const CJK_RE = /[㐀-鿿]/;

// 台词后括号里的外语翻译，如 (La dosis del frasco es suficiente.)；
// 没有中文、且像一句话（≥2 个词或 ≥8 个字符）才算，(OS) (V.O.) 这类保留
function stripTranslations(text) {
  return text.replace(/[（(][^（）()]*[）)]/g, (m) => {
    const inner = m.slice(1, -1).trim();
    if (CJK_RE.test(inner) || !/[A-Za-zÀ-ÿ¿¡]{2}/.test(inner)) return m;
    return /\s/.test(inner) || inner.length >= 8 ? '' : m;
  });
}

function nextNonEmpty(paras, i) {
  for (let j = i + 1; j < paras.length; j++) if (paras[j]) return paras[j];
  return '';
}

function segment(paras) {
  // 正文起点：有「正文内容 / 正文」标记就从它后面开始
  let start = paras.findIndex((t) => /^(正文内容|正文)$/.test(t));
  start = start < 0 ? 0 : start + 1;

  const heads = [];
  const outlineTitles = new Map(); // 分集大纲里的集标题，用来给正文补标题
  for (let i = 0; i < paras.length; i++) {
    const t = paras[i];
    if (!t || t.length > 60) continue;
    const m = HEAD_RE.exec(t);
    if (!m) continue;
    const no = toNumber(m[1]);
    if (/^[（(【]?本集/.test(nextNonEmpty(paras, i))) {
      // 分集大纲条目：不是正文
      if (m[2]) outlineTitles.set(no, m[2].trim());
      continue;
    }
    if (i >= start) heads.push({ idx: i, no, title: (m[2] || '').trim() });
  }
  return { heads, outlineTitles };
}

function analyzeParagraphs(paras) {
  const { heads, outlineTitles } = segment(paras);

  if (!heads.length) {
    return { lang: 'zh', episodes: [], issues: [{ type: 'no-episode', text: '没有识别到「第N集」分集标题' }] };
  }

  const bodies = heads.map((h, k) => {
    const end = k + 1 < heads.length ? heads[k + 1].idx : paras.length;
    return paras.slice(h.idx + 1, end).filter(Boolean);
  });
  // 只用正文判定语言，不让中文集标题、场景头和「人物：」影响英文剧本。
  // 有汉字正文就按中文统计，避免较长的外语翻译把中文剧本误判为英文。
  const allBody = bodies.flat();
  const dialogue = allBody.filter((t) => !SCENE_RE.test(t) && !CAST_RE.test(t));
  const languageText = (dialogue.length ? dialogue : allBody).join('\n');
  const lang = !countHan(languageText) && /\p{Script=Latin}/u.test(languageText) ? 'en' : 'zh';
  const counter = lang === 'en' ? countEnglish : countHan;
  const sum = (arr, count = countWords) => arr.reduce((n, t) => n + count(t), 0);

  const episodes = heads.map((h, k) => {
    const body = bodies[k];
    const cleaned = body.map(stripTranslations);
    const pure = cleaned.filter((t) => !SCENE_RE.test(t) && !CAST_RE.test(t));
    // 英文正文的括号可能是动作或台词，不能当作外语翻译删掉。
    const countClean = lang === 'en' ? body : cleaned;
    const countPure = countClean.filter((t) => !SCENE_RE.test(t) && !CAST_RE.test(t));
    return {
      no: h.no,
      title: h.title || outlineTitles.get(h.no) || '',
      scenes: body.filter((t) => SCENE_RE.test(t)).length,
      paragraphs: body.length,
      // full：整集原文（含场景头、人物行、外语翻译），与 WPS 选中整集所见一致
      // clean：去掉外语翻译括号
      // pure：再去掉场景头、人物行，只剩台词与动作
      words: { full: sum(body), clean: sum(cleaned), pure: sum(pure) },
      counts: { full: sum(body, counter), clean: sum(countClean, counter), pure: sum(countPure, counter) },
    };
  });

  const issues = [];
  const seen = new Set();
  const dups = new Set();
  for (const e of episodes) (seen.has(e.no) ? dups : seen).add(e.no);
  if (dups.size) issues.push({ type: 'dup', text: `集号重复：第${[...dups].join('、')}集` });
  const nos = [...seen].sort((a, b) => a - b);
  const gaps = [];
  for (let n = nos[0]; n <= nos[nos.length - 1]; n++) if (!seen.has(n)) gaps.push(n);
  if (gaps.length) issues.push({ type: 'gap', text: `缺集：第${gaps.join('、')}集` });
  if (nos[0] !== 1) issues.push({ type: 'start', text: `首集是第${nos[0]}集，不是第1集` });

  return { lang, episodes, issues };
}

module.exports = { analyzeParagraphs, stripTranslations, toNumber };
