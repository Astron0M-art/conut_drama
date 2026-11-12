// 分集 + 统计：输入段落数组，输出每集字数（三种口径）
'use strict';

const { countWords, countHan, countChineseDrama, countEnglish } = require('./wps');

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
// 3-1、3-2 中第一个数字是集号；兼容独立场次号和 Word 常见的全角/长横线。
const SCENE_RE = /^([0-9０-９]+)\s*[-‐‑‒–—－]\s*([0-9０-９]+)(?=$|[\s　:：、.．日夜早晚内外])/u;
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

// 仅用于识别标题，统计仍使用原始正文。Word 的 run/底色由 DOCX 层处理，
// Markdown 的标题标记、强调和不可见字符不能妨碍识别正文范围。
function headingText(text) {
  return text.replace(/[\u200b-\u200d\ufeff]/g, '').trim()
    .replace(/^#{1,6}\s*/, '').replace(/\s+#+$/, '')
    .replace(/^(?:\*\*|__)([\s\S]*?)(?:\*\*|__)$/, '$1').trim();
}

function sectionKind(text) {
  const title = headingText(text).replace(/\s+/g, '')
    .replace(/^(?:[一二三四五六七八九十0-9]+[、.．]|[（(][一二三四五六七八九十0-9]+[）)])/, '')
    .replace(/^[【\[](.+)[】\]]$/, '$1').replace(/[：:]$/, '');
  if (/^(剧本正文(?:内容)?|剧本内容|正文内容|正文)$/.test(title)) return 'body';
  if (/^(分集大纲|分级大纲|分集梗概|分集概要|剧情大纲|故事大纲)$/.test(title)) return 'outline';
  return '';
}

function sceneMatch(text) {
  return SCENE_RE.exec(headingText(text));
}

function followedByOutline(paras, i) {
  return /^[（(【]?本集/.test(headingText(nextNonEmpty(paras, i)));
}

function segment(paras) {
  const sections = paras.map(sectionKind);
  const marker = sections.indexOf('body');
  const start = marker < 0 ? 0 : marker + 1;
  const nextOutline = marker < 0 ? -1 : sections.indexOf('outline', start);
  const end = nextOutline < 0 ? paras.length : nextOutline;
  const heads = [];
  const outlineTitles = new Map(); // 大纲只可补集标题，不参与正文分集或字数

  // 有大纲却找不到正文范围时，不把大纲当成可统计的剧本。
  if (marker < 0 && sections.includes('outline')) {
    return { heads, outlineTitles, end, noBody: true };
  }
  for (let i = 0; i < (marker < 0 ? paras.length : start); i++) {
    const m = HEAD_RE.exec(headingText(paras[i]));
    if (m && m[2] && (i < start || followedByOutline(paras, i))) {
      outlineTitles.set(toNumber(m[1]), m[2].trim());
    }
  }

  for (let i = start; i < end; i++) {
    const t = headingText(paras[i]);
    if (!t) continue;
    const m = t.length <= 60 ? HEAD_RE.exec(t) : null;
    if (m) {
      // 未标记正文的旧式纯文本，保留“本集：”大纲排除规则。
      if (marker < 0 && followedByOutline(paras, i)) continue;
      heads.push({ idx: i, bodyStart: i + 1, no: toNumber(m[1]), title: (m[2] || '').trim() });
      continue;
    }
    const scene = sceneMatch(t);
    if (!scene) continue;
    const no = toNumber(scene[1]);
    if (!heads.length || heads[heads.length - 1].no !== no) {
      // 场次头本身属于正文，不能像“第N集”标题那样丢弃。
      heads.push({ idx: i, bodyStart: i, no, title: '' });
    }
  }
  return { heads, outlineTitles, end, noBody: false };
}

function analyzeParagraphs(paras) {
  const { heads, outlineTitles, end: scopeEnd, noBody } = segment(paras);

  if (!heads.length) {
    return { lang: 'zh', episodes: [], issues: [{ type: 'no-episode', text: noBody
      ? '检测到分集大纲，但未找到「剧本正文」；未统计大纲，请补充正文标题和内容'
      : '正文中没有识别到「第N集」或「N-场次」分集标记' }] };
  }

  const bodies = heads.map((h, k) => {
    const end = k + 1 < heads.length ? heads[k + 1].idx : scopeEnd;
    return paras.slice(h.bodyStart, end).filter(Boolean);
  });
  // 只用正文判定语言，不让中文集标题、场景头和「人物：」影响英文剧本。
  // 有汉字正文就按中文统计，避免较长的外语翻译把中文剧本误判为英文。
  const allBody = bodies.flat();
  const dialogue = allBody.filter((t) => !sceneMatch(t) && !CAST_RE.test(t));
  const languageText = (dialogue.length ? dialogue : allBody).join('\n');
  const lang = !countHan(languageText) && /\p{Script=Latin}/u.test(languageText) ? 'en' : 'zh';
  const counter = lang === 'en' ? countEnglish : countChineseDrama;
  const sum = (arr, count = countWords) => arr.reduce((n, t) => n + count(t), 0);

  const episodes = heads.map((h, k) => {
    const body = bodies[k];
    const cleaned = body.map(stripTranslations);
    const pure = cleaned.filter((t) => !sceneMatch(t) && !CAST_RE.test(t));
    // 英文正文的括号可能是动作或台词，不能当作外语翻译删掉。
    const countClean = lang === 'en' ? body : cleaned;
    const countPure = countClean.filter((t) => !sceneMatch(t) && !CAST_RE.test(t));
    return {
      no: h.no,
      title: h.title || outlineTitles.get(h.no) || '',
      scenes: body.filter((t) => sceneMatch(t)).length,
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
