// 格式校验：输入逻辑段落，输出逐段分类（blocks）+ 问题清单（issues，带段落号与可选自动修复）
'use strict';

const S = require('./spec');

const EP_HEAD = /^第\s*([0-9０-９]+|[零〇一二两三四五六七八九十百]+)\s*集/;
const SCENE_LOOSE = /^([0-9０-９]+)\s*[-‐‑‒–—－~～]\s*([0-9０-９]+)(?=$|[\s　:：、.．日夜早晚内外])/u;
const SCENE_STRICT = /^(\d+)-(\d+) (\S+) (内|外|内\/外|外\/内|内外) (\S.*)$/;
const TRAIL_TRANSLATION = /\s*[（(][^（()）㐀-鿿]*[A-Za-z][^（()）㐀-鿿]*[）)]\s*$/;
const DIALOG = /^([^△：:（()），。！？、\s][^△：:（()），。！？、]{0,19}?)\s*(（[^（）]*）|[Oo][Ss]|[Vv][Oo]|V\.O\.)?([：:])\s*(\S[\s\S]*)?$/;
const STAGE_STD = /^[起承转合]（第 \d+ – \d+ 集）$/;
const STAGE_LOOSE = /^([起承转合])\s*[（(]\s*第\s*(\d+)\s*[–—\-－~～至到]\s*(\d+)\s*集\s*[）)]$/;
const num = (s) => S.toNum(s);
const halfToFull = (s) => s.replace(/[:]/, '：');

function check(paras) {
  const blocks = paras.map((text, para) => ({ para, text, kind: 'unknown', issues: [] }));
  const issues = [];
  let nid = 0;
  const add = (para, level, code, message, fix, extra = {}) => {
    const it = { id: ++nid, level, code, para, message, fixable: Boolean(fix), ...(fix ? { fix } : {}), ...extra };
    issues.push(it);
    if (para != null && blocks[para]) blocks[para].issues.push(it.id);
    return it;
  };
  const setKind = (i, kind, extra) => { blocks[i].kind = kind; if (extra) Object.assign(blocks[i], extra); };

  /* ---- 1. 只认「正文内容」标题；它之前的梗概/人物/大纲格式混乱也不拦截，仅做版式归类 ---- */
  if (!paras.length) { add(null, 'error', 'empty-doc', '文件没有任何文字内容'); return finish(); }
  const heads = [];
  paras.forEach((t, i) => {
    const key = S.headingKey(t);
    if (key) heads.push({ i, key });
  });
  if (/^《.+》$/.test(paras[0])) setKind(0, 'title');

  let bodyHead = -1;
  for (const h of heads) {
    if (h.key === 'body') {
      if (bodyHead >= 0) { add(h.i, 'error', 'heading-duplicate', '「正文内容」标题重复出现，只保留一个'); continue; }
      bodyHead = h.i;
      setKind(h.i, 'h2', { section: 'body' });
      if (paras[h.i] !== S.HEADING.body) add(h.i, 'warn', 'heading-nonstandard', `正文标题应写作「${S.HEADING.body}」，当前为「${paras[h.i]}」`, { op: 'set', text: S.HEADING.body });
    }
  }
  if (bodyHead < 0) {
    add(null, 'error', 'section-missing', '找不到「正文内容」标题：请在剧本正文前单独加一行「正文内容」，字数只统计它之后的内容', null, { section: 'body' });
  }

  // 正文之前：仅归类，用于还原版式，不产生任何问题
  const pre = heads.filter((h) => h.key !== 'body' && (bodyHead < 0 || h.i < bodyHead));
  pre.forEach((h, n) => {
    setKind(h.i, 'h2', { section: h.key });
    const end = pre[n + 1] ? pre[n + 1].i : (bodyHead >= 0 ? bodyHead : paras.length);
    for (let i = h.i + 1; i < end; i++) {
      const m = /^([^：:\n]{1,12})([：:])/.exec(paras[i]);
      if (h.key === 'synopsis') setKind(i, m && S.SYNOPSIS_FIELDS.includes(m[1].trim()) ? 'field' : 'text', m ? { label: m[1].trim() } : undefined);
      else if (h.key === 'chars') setKind(i, m && S.CHAR_FIELDS.includes(m[1].trim()) ? 'pfield' : 'text', m ? { label: m[1].trim() } : undefined);
      else setKind(i, STAGE_LOOSE.test(paras[i]) ? 'stage' : (/^第\s*[0-9０-９]+\s*集[：:]/.test(paras[i]) ? 'jigang' : 'rough'));
    }
  });

  if (bodyHead >= 0) checkBody([bodyHead + 1, paras.length]);

  /* ---- 正文内容 ---- */
  function checkBody(r) {
    if (!r) return null;
    let ep = null; // 当前集号
    let lastM = 0;
    let sceneAt = -1; // 最近的场次头
    let castSeen = false;
    let cur = null; // 当前集 {n, i, scenes}
    const epList = [];
    const seenEps = new Set();

    const closeScene = () => { if (sceneAt >= 0 && !castSeen) add(sceneAt, 'warn', 'cast-missing', '场次头后面必须紧跟一行「人物：…」'); };
    const startEp = (n, i) => {
      closeScene(); sceneAt = -1; castSeen = false;
      cur = { n, i, scenes: 0 };
      epList.push(cur);
      ep = n; lastM = 0;
    };

    for (let i = r[0]; i < r[1]; i++) {
      const t = paras[i];
      const hm = EP_HEAD.exec(t.replace(/^(?:\*\*|__)([\s\S]*?)(?:\*\*|__)$/, '$1').trim());
      if (hm && t.length <= 40) {
        const n = num(hm[1]);
        setKind(i, 'ep', { ep: n });
        const std = `第${n}集`;
        const prev = epList[epList.length - 1];
        if (prev && prev.n === n && prev.scenes === 0) {
          add(i, 'warn', 'episode-dup-heading', `「${std}」标题连续重复`, { op: 'delete' });
          continue;
        }
        if (t !== std) add(i, 'warn', 'episode-heading-format', `集标题应单独成行，写作「${std}」（不带标题或空格），当前为「${t}」`, { op: 'set', text: std });
        if (seenEps.has(n)) add(i, 'error', 'episode-duplicate', `第${n}集出现了多次，每集只能有一个标题`);
        else if (prev && n < prev.n) add(i, 'error', 'episode-order', `集号倒退：第${prev.n}集之后出现了第${n}集`);
        seenEps.add(n);
        startEp(n, i);
        continue;
      }

      const sm = SCENE_LOOSE.exec(t);
      if (sm) {
        const p = num(sm[1]); const m = num(sm[2]);
        let fixedNo = null; // 修正后的「集-场」
        if (ep === null) {
          add(i, 'error', 'episode-heading-missing', `场次 ${p}-${m} 前缺少「第${p}集」标题`, { op: 'insertBefore', text: `第${p}集` });
          setKind(i, 'scene'); startEp(p, i); seenEps.add(p);
          blocks[i].virtualEp = true;
        } else if (p !== ep) {
          if (p > ep && !seenEps.has(p)) {
            add(i, 'error', 'episode-heading-missing', `场次 ${p}-${m} 前缺少「第${p}集」标题（上一集是第${ep}集）`, { op: 'insertBefore', text: `第${p}集` });
            startEp(p, i); seenEps.add(p);
          } else if (p < ep && String(ep).endsWith(String(p))) {
            fixedNo = `${ep}-${lastM + 1}`;
            add(i, 'error', 'scene-episode-mismatch', `第${ep}集下出现场次 ${p}-${m}，疑似把集号「${ep}」写成了「${p}」，应为 ${fixedNo}`, { op: 'set', text: t.replace(SCENE_LOOSE, fixedNo) });
          } else {
            add(i, 'error', 'scene-episode-mismatch', `场次 ${p}-${m} 的集号与当前「第${ep}集」不一致：若属于第${ep}集应写 ${ep}-${lastM + 1}；若是第${p}集，则缺少「第${p}集」标题`);
          }
        }
        closeScene();
        sceneAt = i; castSeen = false;
        setKind(i, 'scene');
        const useEp = ep; // startEp 可能已更新
        if (fixedNo === null && p === useEp && m !== lastM + 1) {
          const want = `${useEp}-${lastM + 1}`;
          add(i, 'warn', 'scene-sequence', `第${useEp}集的场次号应连续：这里应是 ${want}，实际是 ${p}-${m}`, { op: 'set', text: t.replace(SCENE_LOOSE, want) });
          lastM = lastM + 1;
        } else lastM = fixedNo ? lastM + 1 : m;
        if (cur) cur.scenes++;
        // 场次头格式
        const cur2 = blocks[i].issues.length ? null : t;
        const base = fixedNo ? t.replace(SCENE_LOOSE, fixedNo) : t;
        void cur2;
        if (!SCENE_STRICT.test(base.replace(/\s+/g, ' ').trim()) || base !== base.replace(/\s+/g, ' ').trim()) {
          const norm = base.replace(/\s+/g, ' ').replace(/^(\d+)\s*[–—－‐‑‒~～]\s*(\d+)/, '$1-$2').trim();
          const tm = /^(\d+-\d+) (\S+) (\S+) (.+)$/.exec(norm);
          if (tm && (tm[2] === '内' || tm[2] === '外') && tm[3] !== '内' && tm[3] !== '外') {
            add(i, 'warn', 'scene-format', '场次头顺序应为「集-场 时间 内/外 地点」，已把「内/外」与时间对调', { op: 'set', text: `${tm[1]} ${tm[3]} ${tm[2]} ${tm[4]}` });
          } else if (SCENE_STRICT.test(norm) && norm !== base) {
            add(i, 'warn', 'scene-format', '场次头的空格、连接符不规范，应为「1-1 日 外 地点」', { op: 'set', text: norm });
          } else if (!SCENE_STRICT.test(norm)) {
            add(i, 'warn', 'scene-format', '场次头必须写作「集-场 时间 内/外 地点」，例如「1-1 日 外 炼器堂-后院」');
          }
        }
        const loc = (SCENE_STRICT.exec(blocks[i].text.replace(/\s+/g, ' ')) || [])[5] || '';
        if (loc && TRAIL_TRANSLATION.test(loc)) {
          const stripped = (fixedNo ? t.replace(SCENE_LOOSE, fixedNo) : t).replace(TRAIL_TRANSLATION, '').trim();
          if (!blocks[i].issues.some((id) => issues.find((x) => x.id === id && x.fix))) add(i, 'warn', 'scene-translation', '场次头地点后带有外文翻译，标准格式不含', { op: 'set', text: stripped });
        }
        continue;
      }

      // 场次内的行
      if (ep === null) { add(i, 'error', 'body-before-episode', '正文必须先写「第1集」标题'); continue; }
      if (sceneAt < 0) { add(i, 'warn', 'body-before-scene', `第${ep}集的标题之后必须先有场次头（如 ${ep}-1 日 外 地点），再写内容`); continue; }

      if (/^人物[：:]/.test(t)) {
        setKind(i, 'cast');
        if (castSeen) add(i, 'warn', 'cast-duplicate', '一个场次只能有一行「人物：」');
        else if (i !== sceneAt + 1) add(i, 'warn', 'cast-position', '「人物：」必须紧跟在场次头下一行');
        castSeen = true;
        if (/^人物:/.test(t)) add(i, 'warn', 'colon-halfwidth', '「人物」后必须使用全角冒号「：」', { op: 'set', text: t.replace(/^人物:/, '人物：') });
        if (!/^人物[：:]\s*\S/.test(t)) add(i, 'warn', 'cast-empty', '「人物：」后面不能为空');
        continue;
      }
      if (!castSeen && i === sceneAt + 1) { /* 场次头后不是人物行，下面的 closeScene 会报 */ }

      if (t.startsWith('△')) {
        setKind(i, 'action');
        if (!/^△\S/.test(t)) {
          if (!t.slice(1).trim()) add(i, 'warn', 'action-empty', '「△」后面没有动作内容');
          else add(i, 'warn', 'action-space', '「△」与动作文字之间不要有空格', { op: 'set', text: `△${t.slice(1).trim()}` });
        }
        continue;
      }
      const dm = DIALOG.exec(t);
      if (dm && dm[4]) {
        setKind(i, 'dialog', { role: dm[1].trim(), tag: dm[2] || '' });
        if (dm[3] === ':') add(i, 'warn', 'dialog-colon', '台词应使用全角冒号「角色（情绪）：台词」', { op: 'set', text: t.replace(/^([^：:]*?)\s*:/, '$1：') });
        continue;
      }
      if (/^【[^】]*】$/.test(t)) { setKind(i, 'marker'); add(i, 'warn', 'marker-line', '「【…】」标记行不在标准格式内（参考稿正文只有场次头、人物、△动作、台词），建议并入△动作'); continue; }
      if (/^[（(]\s*(中|英|西|法|日|韩|俄|阿)\s*[：:]/.test(t)) { setKind(i, 'translation'); add(i, 'error', 'translation-line', '独立成行的括号翻译会影响字数统计，必须删除或并入上一句台词后面', { op: 'delete' }); continue; }
      add(i, 'warn', 'body-line-unknown', '无法识别的行：正文只能是「△动作」、「角色（情绪）：台词」、场次头、人物行或集标题。若是动作描写请以「△」开头', { op: 'set', text: `△${t.replace(/^△\s*/, '')}` });
    }
    closeScene();
    // 集号连续性 / 空集
    let expect = 1;
    for (const e of epList) {
      if (e.n > expect) {
        const list = []; for (let k = expect; k < e.n && list.length < 6; k++) list.push(k);
        add(e.i, 'error', 'episode-missing', `缺少第 ${list.join('、')}${e.n - expect > 6 ? ' 等' : ''}集：第${expect === e.n - 1 ? expect : `${expect}–${e.n - 1}`}集在正文中不存在（前后集号不连续）`);
      } else if (e.n < expect && e.n !== expect - 1) { /* 已报倒退 */ }
      expect = Math.max(expect, e.n + 1);
      if (!e.scenes) add(e.i, 'error', 'episode-empty', `第${e.n}集没有任何场次内容`);
    }
    if (epList.length && epList[0].n !== 1) add(epList[0].i, 'warn', 'episode-first', `正文必须从第 1 集开始，实际首集是第 ${epList[0].n} 集`);
    if (!epList.length) add(r[0] - 1, 'error', 'episode-none', '正文中没有任何「第N集」标题');
    const ns = [...new Set(epList.map((e) => e.n))];
    return { count: ns.length, max: ns.length ? Math.max(...ns) : 0 };
  }

  return finish();

  function finish() {
    const errors = issues.filter((x) => x.level === 'error');
    const warns = issues.filter((x) => x.level === 'warn');
    issues.sort((a, b) => (a.para ?? -1) - (b.para ?? -1) || a.id - b.id);
    return {
      ok: errors.length === 0,
      errors: errors.length,
      warns: warns.length,
      fixable: issues.filter((x) => x.fixable).length,
      issues,
      blocks,
    };
  }
}

module.exports = { check };
