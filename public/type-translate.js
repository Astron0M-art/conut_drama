'use strict';

/*
 * 正文翻译页是独立于现有格式校验页的第二个入口。
 * 这里故意只使用 /api/validate 的段落/analysis 结果和翻译任务 API，
 * 不读写现有 type 页面的全局状态，方便两个页面并行迭代。
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => Number(n || 0).toLocaleString('zh-CN');
  const EXT_RE = /\.(docx|txt|md)$/i;
  const state = {
    file: null,
    name: '',
    paragraphs: [],
    validation: null,
    episodes: [],
    missingEpisodes: [],
    sourceEpisodes: [],
    activeSourceKey: '',
    sourceCleanup: null,
    selected: new Set(),
    statuses: new Map(),
    results: new Map(),
    jobId: '',
    source: null,
    pollTimer: null,
    done: false,
    batchFailed: false,
    busy: false,
    pollStarted: false,
    errors: new Map(),   // 集号 -> 失败原因
    exported: false,     // 当前译文是否已导出（防误关页面）
    startedAt: 0,
    timer: null,
    models: null,        // /api/translate/models 的结果
  };

  const store = {
    get(key, fallback = '') { try { return localStorage.getItem(`tt.${key}`) ?? fallback; } catch (_) { return fallback; } },
    set(key, value) { try { localStorage.setItem(`tt.${key}`, value); } catch (_) { /* 隐私模式等 */ } },
  };

  // 线上是 HTTP，navigator.clipboard 不可用：先试它，失败回退 execCommand
  async function copyText(text) {
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch (_) { /* 降级 */ }
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    ta.remove();
    return ok;
  }

  function toast(message) {
    const node = $('toast');
    node.textContent = message;
    node.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.remove('show'), 3200);
  }

  function authFailure() {
    location.href = '/login?expired=1';
  }

  async function request(url, options = {}) {
    const response = await fetch(url, options);
    if (response.status === 401) { authFailure(); throw new Error('登录已过期'); }
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error || `服务器返回 ${response.status}`);
    }
    return response;
  }

  async function jsonRequest(url, body) {
    return request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function headingText(value) {
    return String(value || '').replace(/[\u200b-\u200d\ufeff]/g, '').trim()
      .replace(/^#{1,6}\s*/, '').replace(/\s+#+$/, '')
      .replace(/^(?:\*\*|__)([\s\S]*?)(?:\*\*|__)$/, '$1').trim();
  }

  function episodeHeading(text) {
    const m = /^第\s*([0-9０-９]+|[零〇一二两三四五六七八九十百]+)\s*集\s*(?:[：:、\-—·.．]?\s*(.*))?$/.exec(headingText(text));
    if (!m) return null;
    const raw = m[1].replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    const cn = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    let no = 0;
    if (/^\d+$/.test(raw)) no = Number(raw);
    else {
      let section = 0; let current = 0;
      for (const ch of raw) {
        if (ch === '十' || ch === '百') {
          const unit = ch === '百' ? 100 : 10;
          section += (current || 1) * unit; current = 0;
        } else current = cn[ch] || current;
      }
      no = section + current;
    }
    return { no, title: (m[2] || '').trim() };
  }

  function sceneHeading(text) {
    const m = /^([0-9０-９]+)\s*[-‐‑‒–—－]\s*([0-9０-９]+)(?=$|[\s　:：、.．日夜早晚内外])/u.exec(headingText(text));
    if (!m) return null;
    const normal = (s) => Number(s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)));
    return { episode: normal(m[1]), scene: normal(m[2]) };
  }

  function isBodyMarker(text) {
    const t = headingText(text).replace(/[：:]/g, '').replace(/\s+/g, '');
    return /^(剧本正文(?:内容)?|剧本内容|正文内容|正文)$/.test(t);
  }

  function markedOutText(text, spans) {
    if (!Array.isArray(spans) || !spans.length) return text;
    let out = ''; let cursor = 0;
    for (const pair of spans) {
      const start = Math.max(0, Number(pair && pair[0]) || 0);
      const end = Math.max(start, Number(pair && pair[1]) || start);
      out += text.slice(cursor, start); cursor = Math.max(cursor, end);
    }
    return out + text.slice(cursor);
  }

  function detectionParagraphs(paragraphs, marks = {}) {
    return paragraphs.map((text, index) => markedOutText(text, marks && (marks[index] || marks[String(index)])));
  }

  // 格式尚未通过时 /api/validate 不一定返回 analysis；这里仅做页面定位兜底。
  // 正式统计仍由服务端完成，客户端不会把这个近似值当作字数合同。
  function fallbackEpisodes(paragraphs, marks) {
    const scan = detectionParagraphs(paragraphs, marks);
    const marker = scan.findIndex(isBodyMarker);
    const start = marker < 0 ? 0 : marker + 1;
    const out = [];
    let current = null;
    const begin = (no, title, explicit) => {
      if (!Number.isFinite(no) || no <= 0) return null; // 防止 0-1 伪造出「第0集」
      const previous = out[out.length - 1];
      if (previous && previous.no === no) {
        if (!previous.title && title) previous.title = title;
        current = previous;
        return previous;
      }
      current = { no, title: title || '', scenes: 0, paragraphs: 0, _explicit: !!explicit };
      out.push(current);
      return current;
    };
    for (let i = start; i < paragraphs.length; i++) {
      const text = scan[i];
      if (!headingText(text)) continue;
      const ep = episodeHeading(text);
      if (ep) { begin(ep.no, ep.title, true); continue; }
      const scene = sceneHeading(text);
      if (scene) {
        if (!current) {
          // 没有集标题时，0-1 不能成为虚假的第 0 集；等待后面的有效标题。
          if (scene.episode <= 0) continue;
          begin(scene.episode, '', false);
        } else if (scene.episode > 0 && scene.episode !== current.no
          && (!current._explicit || scene.episode > current.no)) {
          // 显式集标题仍优先；出现更大的场次集号才创建漏写的后续集。
          begin(scene.episode, '', false);
        }
        if (current) { current.scenes++; current.paragraphs++; }
        continue;
      }
      if (current) current.paragraphs++;
    }
    return out.map(({ _explicit, ...episode }) => episode);
  }

  function normalizeEpisodes(raw, paragraphs, marks) {
    const source = Array.isArray(raw) && raw.length ? raw : fallbackEpisodes(paragraphs, marks);
    const grouped = new Map();
    for (const item of source) {
      const no = Number(item && (item.no ?? item.episodeNo ?? item.episode));
      if (!Number.isFinite(no) || no <= 0) continue;
      if (!grouped.has(no)) {
        grouped.set(no, {
          ...item,
          no,
          title: String(item.title || ''),
          scenes: Number(item.scenes || 0),
          paragraphs: Number(item.paragraphs || 0),
        });
      } else {
        const existing = grouped.get(no);
        if (!existing.title && item.title) existing.title = String(item.title);
        existing.scenes += Number(item.scenes || 0);
        existing.paragraphs += Number(item.paragraphs || 0);
      }
    }
    return [...grouped.values()].sort((a, b) => a.no - b.no).map((episode, index) => ({
      ...episode,
      key: `${episode.no}:${index}`,
      status: 'idle',
      progress: 0,
    }));
  }

  // 翻译服务要求每集带正文文本和原始段落索引。索引来自同一份逻辑段落，
  // 这样 2-1、2-2 以及分页后重复的「第N集」都会落到同一个集号下。
  function episodeIndexes(paragraphs, marks) {
    const scan = detectionParagraphs(paragraphs, marks);
    const marker = scan.findIndex(isBodyMarker);
    const start = marker < 0 ? 0 : marker + 1;
    const byNo = new Map();
    let current = null;
    const create = (no, explicit = false) => {
      if (!Number.isFinite(no) || no <= 0) return null;
      current = byNo.get(no) || { no, indexes: [], explicit: false };
      current.explicit = current.explicit || explicit;
      byNo.set(no, current);
      return current;
    };
    for (let i = start; i < paragraphs.length; i++) {
      const text = scan[i];
      if (!headingText(text)) continue;
      const ep = episodeHeading(text);
      if (ep) {
        const target = create(ep.no, true);
        if (target) target.indexes.push(i);
        continue;
      }
      const scene = sceneHeading(text);
      if (scene) {
        if (!current) {
          if (scene.episode <= 0) continue;
          create(scene.episode, false);
        } else if (scene.episode > 0 && scene.episode !== current.no
          && (!current.explicit || scene.episode > current.no)) {
          // 显式「第N集」是边界权威：1 集下的 0-1/1-2 仍归 1 集，
          // 但出现 2-1 时要切到第 2 集，即使第2集标题漏了。
          create(scene.episode, false);
        }
        if (current) current.indexes.push(i);
        continue;
      }
      if (current) current.indexes.push(i);
    }
    return byNo;
  }

  function setStatus(no, status, progress) {
    const n = Number(no);
    for (const episode of state.episodes) {
      if (episode.no !== n) continue;
      episode.status = status || episode.status;
      if (progress != null && Number.isFinite(Number(progress))) episode.progress = Math.max(0, Math.min(100, Number(progress)));
      state.statuses.set(episode.key, episode.status);
    }
  }

  function currentStep() {
    if (!state.file || !state.episodes.length) return 1;
    if (state.busy) return 3;
    if (state.results.size) return 4;
    return 2;
  }

  function renderSteps() {
    const step = currentStep();
    document.querySelectorAll('#tsteps li[data-step]').forEach((node) => {
      const n = Number(node.dataset.step);
      node.className = n < step ? 'done' : (n === step ? 'cur' : '');
    });
  }

  function elapsedText(ms) {
    const sec = Math.max(0, Math.floor(ms / 1000));
    return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  }

  function startTimer() {
    stopTimer();
    state.startedAt = Date.now();
    const tick = () => {
      $('jobElapsed').textContent = `用时 ${elapsedText(Date.now() - state.startedAt)}`;
      if (!state.busy) stopTimer();
    };
    tick();
    state.timer = setInterval(tick, 1000);
  }

  function stopTimer() { if (state.timer) { clearInterval(state.timer); state.timer = null; } }

  // 模型/Coze 没配置时不让提交，避免整批集一个个失败
  function translateBlocker() {
    const info = state.models;
    if (!info) return '';
    if (!info.mock && !info.coze) return '服务器未配置 Coze 工作流凭据，暂时无法翻译';
    const item = info.models.find((m) => m.key === $('model').value);
    if (item && !item.configured) return `服务器未配置「${item.label}」的密钥，请换一个模型`;
    return '';
  }

  function renderFailed() {
    const node = $('failedList');
    const failed = state.episodes.filter((e) => e.status === 'error');
    node.hidden = !failed.length;
    node.innerHTML = failed.slice(0, 8).map((e) => `<li><b>第${fmt(e.no)}集</b>${esc(state.errors.get(e.no) || '翻译失败')}</li>`).join('')
      + (failed.length > 8 ? `<li>…另有 ${failed.length - 8} 集失败</li>` : '');
    $('retryFailed').hidden = !failed.length || state.busy;
    $('retryFailed').textContent = `重试失败的集（${failed.length}）`;
  }

  function collectErrors(payload) {
    if (!payload) return;
    const list = [];
    if (payload.error && Array.isArray(payload.error.episodes)) list.push(...payload.error.episodes);
    if (Array.isArray(payload.failedEpisodes)) list.push(...payload.failedEpisodes);
    if (payload.error && payload.error.episode != null) list.push(payload.error);
    for (const item of list) {
      if (item && item.episode != null) state.errors.set(Number(item.episode), String(item.message || item.code || '翻译失败'));
    }
  }

  function selectedEpisodes() {
    return state.episodes.filter((episode) => state.selected.has(episode.key));
  }

  function renderFile() {
    $('fileName').textContent = state.name || '未选择剧本';
    const report = state.validation && state.validation.format;
    const analysis = state.validation && state.validation.analysis;
    const count = state.episodes.length;
    const status = report && report.ok === false ? `格式提示 ${report.errors || 0} 个，可继续定位正文` : '格式已识别';
    $('fileMeta').textContent = state.file ? `${status} · ${count} 集` : '等待上传';
    $('bodyHint').textContent = count ? `正文区识别到 ${count} 集${analysis && analysis.lang === 'en' ? ' · 英文稿' : ''}` : '未识别到有效集标题';
    const warning = $('episodeGapWarning');
    if (warning) {
      if (state.missingEpisodes.length) {
        warning.hidden = false;
        warning.textContent = `检测到集号不连续：缺少 ${formatEpisodeNumbers(state.missingEpisodes)}。请确认原稿是否漏集。`;
      } else {
        warning.hidden = true;
        warning.textContent = '';
      }
    }
  }

  function missingEpisodeNumbers(episodes) {
    const numbers = [...new Set((episodes || []).map((item) => Number(item && item.no)).filter((no) => Number.isInteger(no) && no > 0))].sort((a, b) => a - b);
    if (!numbers.length) return [];
    const seen = new Set(numbers);
    const missing = [];
    for (let no = 1; no <= numbers[numbers.length - 1]; no++) if (!seen.has(no)) missing.push(no);
    return missing;
  }

  function formatEpisodeNumbers(numbers) {
    const values = [...new Set((numbers || []).map(Number).filter((no) => Number.isInteger(no) && no > 0))].sort((a, b) => a - b);
    if (!values.length) return '';
    const ranges = [];
    let start = values[0]; let end = values[0];
    for (let i = 1; i < values.length; i++) {
      if (values[i] === end + 1) { end = values[i]; continue; }
      ranges.push(start === end ? `${start}` : `${start}-${end}`);
      start = end = values[i];
    }
    ranges.push(start === end ? `${start}` : `${start}-${end}`);
    return ranges.map((value) => `第${value}集`).join('、');
  }

  function sourceEpisodeData() {
    const indexesByNo = episodeIndexes(state.paragraphs, state.validation && state.validation.marks);
    return state.episodes.map((episode) => {
      const found = indexesByNo.get(episode.no);
      const indexes = found ? found.indexes : [];
      const text = indexes.map((index) => state.paragraphs[index]).filter((value) => String(value || '').trim()).join('\n').trim();
      return { ...episode, indexes, text };
    }).filter((episode) => episode.text);
  }

  function markActiveSource(key, options = {}) {
    const next = String(key || '');
    if (!next) return;
    state.activeSourceKey = next;
    const source = $('sourceScroll');
    if (source) source.querySelectorAll('.source-episode').forEach((node) => {
      node.classList.toggle('active', node.dataset.episodeKey === next);
    });
    const row = $('episodeList') && $('episodeList').querySelector(`.episode-row[data-episode-key="${CSS.escape(next)}"]`);
    if (row) {
      row.classList.add('active');
      if (options.reveal !== false) row.scrollIntoView({ block: 'nearest' });
    }
    const episode = state.sourceEpisodes.find((item) => item.key === next);
    if ($('sourceCurrent')) $('sourceCurrent').textContent = episode ? `当前：第${fmt(episode.no)}集` : '未定位';
  }

  function sourceKeyFromNode(node) {
    return node && node.dataset ? String(node.dataset.episodeKey || '') : '';
  }

  function sourceScrollTo(key) {
    const source = $('sourceScroll');
    if (!source) return;
    const node = source.querySelector(`.source-episode[data-episode-key="${CSS.escape(String(key || ''))}"]`);
    if (!node) return;
    // 用真实位置而不是 offsetTop（它相对最近的定位祖先，容易偏到下一集）：
    // 短集整段居中，长集让标题落在上方 12% 处
    const box = source.getBoundingClientRect(); const rect = node.getBoundingClientRect();
    const offset = rect.top - box.top + source.scrollTop;
    const target = rect.height < source.clientHeight ? offset - (source.clientHeight - rect.height) / 2 : offset - source.clientHeight * 0.12;
    source.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    // 正文卡片在页面下方时，把它带进视野，否则点了左侧看不到变化
    const card = $('sourceCard');
    if (card) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    markActiveSource(key);
  }

  function syncActiveSourceFromScroll() {
    const source = $('sourceScroll');
    if (!source) return;
    const nodes = [...source.querySelectorAll('.source-episode')];
    if (!nodes.length) return;
    const sourceTop = source.getBoundingClientRect().top;
    let candidate = nodes[0];
    let best = Number.POSITIVE_INFINITY;
    for (const node of nodes) {
      const distance = Math.abs(node.getBoundingClientRect().top - sourceTop - 10);
      if (distance < best) { best = distance; candidate = node; }
    }
    const key = sourceKeyFromNode(candidate);
    if (key && key !== state.activeSourceKey) markActiveSource(key, { reveal: true });
  }

  function teardownSourceScroll() {
    if (state.sourceCleanup) { state.sourceCleanup(); state.sourceCleanup = null; }
  }

  function renderSourcePreview() {
    teardownSourceScroll();
    const card = $('sourceCard');
    const source = $('sourceScroll');
    if (!card || !source) return;
    state.sourceEpisodes = sourceEpisodeData();
    if (!state.sourceEpisodes.length) {
      card.hidden = true;
      source.innerHTML = '';
      state.activeSourceKey = '';
      if ($('sourceCurrent')) $('sourceCurrent').textContent = '未定位';
      return;
    }
    card.hidden = false;
    $('sourceHint').textContent = `已定位 ${state.sourceEpisodes.length} 集正文 · 点击左侧集号跳转，滚动正文时左侧会跟随定位`;
    source.innerHTML = state.sourceEpisodes.map((episode) => `<article class="source-episode" id="source-episode-${esc(episode.key)}" data-episode-key="${esc(episode.key)}" data-episode-no="${esc(episode.no)}">
      <header><h3>第${fmt(episode.no)}集${episode.title ? ` · ${esc(episode.title)}` : ''}</h3><span>${fmt(episode.indexes.length)} 段正文</span></header>
      <pre class="source-text">${esc(episode.text)}</pre>
    </article>`).join('');
    const first = state.sourceEpisodes.find((episode) => episode.key === state.activeSourceKey) || state.sourceEpisodes[0];
    markActiveSource(first.key, { reveal: false });
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; syncActiveSourceFromScroll(); });
    };
    source.addEventListener('scroll', onScroll, { passive: true });
    state.sourceCleanup = () => { source.removeEventListener('scroll', onScroll); if (raf) cancelAnimationFrame(raf); };
  }

  function stateLabel(status) {
    return ({ idle: '待翻译', queued: '排队中', running: '翻译中', done: '已完成', error: '失败' })[status] || '待翻译';
  }

  function renderEpisodes() {
    const episodes = state.episodes;
    $('episodeProgress').textContent = `${episodes.filter((e) => e.status === 'done').length}/${episodes.length}`;
    const chosen = selectedEpisodes();
    $('selectionSummary').textContent = chosen.length ? `已选 ${chosen.length} 集 · ${chosen.map((e) => `第${e.no}集`).join('、')}` : '尚未选择集';
    $('selectAll').checked = Boolean(episodes.length && chosen.length === episodes.length);
    $('selectAll').indeterminate = Boolean(chosen.length && chosen.length < episodes.length);
    $('selectAll').disabled = state.busy || !episodes.length;
    $('selectPending').disabled = state.busy || !episodes.length;
    const blocker = translateBlocker();
    $('startTranslate').disabled = !state.paragraphs.length || !chosen.length || state.busy || Boolean(blocker);
    $('startTranslate').title = blocker || (chosen.length ? '' : '先在左侧勾选要翻译的集');
    $('stopTranslate').hidden = !state.busy;
    $('stopTranslate').disabled = !state.jobId;
    renderFailed();
    renderSteps();
    $('episodeList').innerHTML = episodes.length ? episodes.map((episode) => {
      const status = episode.status || 'idle';
      const meta = status === 'error' && state.errors.get(episode.no) ? state.errors.get(episode.no) : [episode.title, episode.paragraphs ? `${fmt(episode.paragraphs)} 段正文` : '正文已定位'].filter(Boolean).join(' · ');
      return `<label class="episode-row ${state.selected.has(episode.key) ? 'selected' : ''} ${state.activeSourceKey === episode.key ? 'active' : ''}" data-episode-key="${esc(episode.key)}">
        <input type="checkbox" data-episode-key="${esc(episode.key)}" ${state.selected.has(episode.key) ? 'checked' : ''} ${state.busy ? 'disabled' : ''}>
        <span class="episode-title"><b>第${fmt(episode.no)}集</b><small class="${status === 'error' ? 'err' : ''}" title="${esc(meta)}">${esc(meta)}</small></span>
        <span class="episode-state ${esc(status)}">${stateLabel(status)}${status === 'running' && episode.progress ? ` ${episode.progress}%` : ''}</span>
      </label>`;
    }).join('') : '<p class="empty-hint" style="padding:28px 8px">上传后会在这里列出正文集。</p>';
  }

  function textFrom(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object') {
      for (const key of ['translation', 'translatedText', 'text', 'content', 'output', 'result']) {
        if (value[key] != null) return textFrom(value[key]);
      }
      try { return JSON.stringify(value, null, 2); } catch (_) { return String(value); }
    }
    return String(value);
  }

  function resultFor(no, value, status = 'done') {
    const text = textFrom(value);
    if (!text) return;
    state.results.set(String(no), { no: Number(no), text, status });
    if (status === 'done') state.exported = false;
    setStatus(no, status);
  }

  function resultsFrom(value) {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach((item) => {
        const no = item && (item.episodeNo ?? item.episode ?? item.no);
        if (no != null) resultFor(no, item.translation ?? item.output ?? item.result ?? item.text ?? item, 'done');
      });
      return;
    }
    if (typeof value === 'object') {
      const no = value.episodeNo ?? value.episode ?? value.no;
      if (no != null) resultFor(no, value.translation ?? value.output ?? value.result ?? value.text, 'done');
      else if (Array.isArray(value.episodes)) resultsFrom(value.episodes);
    }
  }

  function aggregateProgress(payload = {}) {
    const total = Number(payload.total ?? payload.totalEpisodes ?? selectedEpisodes().length) || 1;
    const completed = Number(payload.completed ?? payload.completedEpisodes ?? payload.done ?? 0);
    const direct = Number(payload.progress ?? payload.percent);
    if (Number.isFinite(direct)) return Math.max(0, Math.min(100, direct <= 1 ? direct * 100 : direct));
    return Math.max(0, Math.min(100, completed / total * 100));
  }

  function updateProgress(status, percent) {
    const p = Math.round(Math.max(0, Math.min(100, Number(percent) || 0)));
    $('jobProgress').hidden = false;
    $('jobStatus').textContent = status || '翻译中';
    $('jobPercent').textContent = `${p}%`;
    $('jobProgressBar').style.width = `${p}%`;
  }

  function handleEvent(raw) {
    let payload = raw;
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch (_) { payload = { message: payload }; }
    }
    if (!payload || typeof payload !== 'object') return;
    const type = String(payload.type || payload.event || payload.status || '').toLowerCase();
    const no = payload.episodeNo ?? payload.episode ?? payload.no ?? payload.episode_number;
    const episodeFailure = type === 'episode_failed' || type === 'episode_error';
    const jobFailure = type === 'job_failed' || type === 'job_error' || type === 'failed';
    collectErrors(payload);
    if (type === 'job_cancelled') { finishCancelled(payload); return; }
    if (Array.isArray(payload.episodeStatuses)) {
      payload.episodeStatuses.forEach((item) => {
        if (item && item.episode != null) setStatus(item.episode, item.status);
      });
    }
    if (no != null) {
      const status = type.includes('error') || payload.error ? 'error' : (type.includes('done') || type.includes('finish') || type.includes('complete') || type === 'completed' ? 'done' : (type.includes('queue') ? 'queued' : 'running'));
      const progress = payload.progress ?? payload.percent;
      setStatus(no, status, progress);
      if (payload.translation != null || payload.translatedText != null || payload.text != null || payload.output != null || payload.result != null) {
        resultFor(no, payload.translation ?? payload.translatedText ?? payload.text ?? payload.output ?? payload.result, status === 'error' ? 'error' : 'done');
      }
    }
    resultsFrom(payload.results || payload.episodes);
    if (episodeFailure) {
      updateProgress('部分集失败，其余集继续翻译', aggregateProgress(payload));
      renderEpisodes();
      renderResults();
      return;
    }
    if (jobFailure || (payload.error && !no)) {
      const message = textFrom(payload.error || payload.message || '翻译任务失败');
      if (jobFailure) {
        finishJob(payload, true);
        showError(message);
        updateProgress('翻译结束，部分集失败', aggregateProgress(payload));
      } else {
        showError(message);
        state.busy = false;
        updateProgress('翻译失败', aggregateProgress(payload));
        renderEpisodes();
      }
      return;
    }
    // 只有任务级终态才结束整批；episode_completed 只更新单集，不能让其它集提前停止。
    const terminal = type === 'job_completed' || type === 'job_failed' || type === 'completed'
      || type === 'done' || payload.finished === true
      || (!no && (payload.status === 'succeeded' || payload.status === 'failed'));
    const percent = terminal ? 100 : aggregateProgress(payload);
    updateProgress(terminal ? '翻译完成' : (payload.message || '翻译中'), percent);
    if (terminal) finishJob(payload);
    renderEpisodes();
    renderResults();
  }

  function finishCancelled(payload = {}) {
    if (state.done) return;
    state.done = true; state.busy = false; state.batchFailed = false;
    for (const no of payload.cancelledEpisodes || []) setStatus(no, 'idle');
    for (const episode of selectedEpisodes()) if (episode.status === 'queued') episode.status = 'idle';
    updateProgress('已停止', aggregateProgress(payload));
    stopStream(); renderEpisodes(); renderResults();
    toast('已停止翻译，已完成的集已保留，可继续翻译或导出');
  }

  function finishJob(payload = {}, partialFailure = false) {
    if (state.done) return;
    state.done = true;
    state.busy = false;
    state.batchFailed = partialFailure;
    collectErrors(payload);
    resultsFrom(payload.result || payload.output);
    // 后端若只发一个整体结果，单集选择时可以预览到第一个集；不虚构其它集内容。
    const selected = selectedEpisodes();
    const overall = textFrom(payload.result || payload.output);
    if (overall && !state.results.size && selected.length === 1) resultFor(selected[0].no, overall);
    for (const episode of selected) {
      if (episode.status === 'running' || episode.status === 'queued') episode.status = state.results.has(String(episode.no)) ? 'done' : 'error';
    }
    updateProgress(partialFailure ? '翻译结束，部分集失败' : '翻译完成', partialFailure ? aggregateProgress(payload) : 100);
    stopStream();
    renderEpisodes();
    renderResults();
    toast(partialFailure ? '翻译已结束，部分集失败，可点「重试失败的集」' : '翻译任务已完成，可预览并导出');
  }

  function showError(message) {
    $('translateError').textContent = message;
    $('translateError').hidden = false;
  }

  function clearError() { $('translateError').hidden = true; $('translateError').textContent = ''; }

  function renderResults() {
    const entries = [...state.results.values()].filter((item) => item && item.text);
    const missing = state.episodes.filter((episode) => !state.results.has(String(episode.no))).map((episode) => episode.no);
    $('resultCard').hidden = entries.length === 0;
    $('emptyResult').hidden = entries.length !== 0;
    $('exportTranslate').disabled = entries.length === 0 || state.busy;
    $('resultHint').textContent = entries.length
      ? (missing.length ? `已完成 ${entries.length}/${state.episodes.length} 集 · ${formatEpisodeNumbers(missing)} 未翻译（导出时保留中文原文）` : `已完成全部 ${entries.length} 集 · 可展开查看译文，确认后导出整本剧本`)
      : '完成的集会显示在这里，可先预览再导出。';
    $('resultList').innerHTML = entries.sort((a, b) => a.no - b.no).map((entry, index) => `<details class="result-item" ${index === 0 ? 'open' : ''}>
      <summary>第${fmt(entry.no)}集<span class="result-meta">${entry.status === 'error' ? '失败' : '已完成'}</span><button type="button" class="copy-one" data-copy-ep="${esc(entry.no)}">复制译文</button></summary>
      <pre class="result-text">${esc(entry.text)}</pre>
    </details>`).join('');
  }

  function stopStream() {
    if (state.source) { state.source.close(); state.source = null; }
    if (state.pollTimer) { clearTimeout(state.pollTimer); state.pollTimer = null; }
  }

  function pollEvents() {
    if (!state.jobId || state.done || state.pollTimer) return;
    state.pollTimer = setTimeout(async () => {
      state.pollTimer = null;
      if (!state.jobId || state.done) return;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4500);
      try {
        const response = await request(`/api/translate/${encodeURIComponent(state.jobId)}`, { headers: { Accept: 'application/json' }, signal: controller.signal });
        const body = await response.json();
        handleEvent({ ...body, type: body.status === 'succeeded' ? 'job_completed' : (body.status === 'failed' ? 'job_failed' : (body.status === 'cancelled' ? 'job_cancelled' : 'job_progress')) });
      } catch (error) {
        if (error.name !== 'AbortError') showError(error.message || '翻译进度读取失败');
      } finally {
        clearTimeout(timeout);
        if (!state.done) pollEvents();
      }
    }, 1000);
  }

  function listenToJob(jobId) {
    stopStream();
    state.done = false;
    const url = `/api/translate/${encodeURIComponent(jobId)}/events`;
    if (typeof EventSource === 'function') {
      const source = new EventSource(url);
      state.source = source;
      const consume = (event) => handleEvent(event.data);
      source.onmessage = consume;
      ['progress', 'episode', 'result', 'done', 'complete', 'completed', 'error', 'message', 'job_started', 'episode_started', 'episode_completed', 'episode_failed', 'job_completed', 'job_failed', 'job_cancelled'].forEach((name) => source.addEventListener(name, consume));
      source.onerror = () => {
        if (state.done) return;
        source.close(); state.source = null;
        if (!state.pollStarted) { state.pollStarted = true; pollEvents(); }
      };
    } else {
      state.pollStarted = true;
      pollEvents();
    }
  }

  function buildStartBody() {
    const episodes = selectedEpisodes();
    const analysis = state.validation && state.validation.analysis;
    const indexesByNo = episodeIndexes(state.paragraphs, state.validation && state.validation.marks);
    const translatedEpisodes = episodes.map((episode) => {
      const found = indexesByNo.get(episode.no);
      const paragraphIndexes = found ? found.indexes : [];
      const text = paragraphIndexes.map((index) => state.paragraphs[index]).join('\n').trim();
      if (!text) throw new Error(`第${episode.no}集没有找到正文段落`);
      return {
        episode: episode.no,
        text,
        paragraphIndexes,
      };
    });
    return {
      name: state.name,
      filename: state.file ? state.file.name : state.name,
      paragraphs: state.paragraphs,
      modelKey: $('model').value,
      targetLanguage: $('targetLanguage').value,
      episodes: translatedEpisodes,
      sourceLang: analysis && analysis.lang ? analysis.lang : 'zh',
      output: { mode: 'bilingual', format: 'docx' },
    };
  }

  async function startTranslation() {
    if (state.busy) return;
    const selected = selectedEpisodes();
    if (!selected.length) { toast('先选择要翻译的集'); return; }
    const blocker = translateBlocker();
    if (blocker) { showError(blocker); return; }
    if (selected.length >= 10) {
      const chars = selected.reduce((sum, episode) => sum + ((episodeIndexes(state.paragraphs, state.validation && state.validation.marks).get(episode.no) || { indexes: [] }).indexes.reduce((n, i) => n + (state.paragraphs[i] || '').length, 0)), 0);
      if (!window.confirm(`将用「${$('model').value}」把 ${selected.length} 集（约 ${fmt(chars)} 字）翻译成${$('targetLanguage').value}，会调用付费模型接口。确认开始？`)) return;
    }
    state.busy = true; state.done = false; state.batchFailed = false; state.pollStarted = false; state.jobId = ''; clearError();
    // 只丢弃这次要重翻的集的旧译文；其它集（以前批次完成的）保留，分批翻译/失败重试都不会丢
    selected.forEach((episode) => { state.results.delete(String(episode.no)); state.errors.delete(episode.no); });
    selected.forEach((episode) => { episode.status = 'queued'; episode.progress = 0; });
    startTimer();
    renderEpisodes(); renderResults(); updateProgress('提交翻译任务', 0);
    try {
      const response = await jsonRequest('/api/translate/start', buildStartBody());
      const body = await response.json();
      const jobId = body.jobId || body.job_id || body.id || (body.job && (body.job.id || body.job.jobId));
      if (!jobId) throw new Error('翻译服务没有返回 jobId');
      state.jobId = String(jobId);
      resultsFrom(body.results || body.episodes);
      if (body.status === 'done' || body.status === 'completed' || body.finished) finishJob(body);
      else listenToJob(state.jobId);
      toast(`已提交 ${selected.length} 集，正在翻译`);
    } catch (error) {
      state.busy = false;
      selected.forEach((episode) => { episode.status = 'idle'; });
      stopTimer();
      updateProgress('提交失败', 0); showError(error.message || '翻译任务提交失败'); renderEpisodes();
    }
  }

  async function stopTranslation() {
    if (!state.jobId || !state.busy) return;
    $('stopTranslate').disabled = true;
    try { await jsonRequest(`/api/translate/${encodeURIComponent(state.jobId)}/cancel`, {}); toast('正在停止：已发出的请求会等它返回，没开始的集不再翻译'); }
    catch (error) { showError(error.message || '停止失败'); $('stopTranslate').disabled = false; }
  }

  async function exportTranslation() {
    const done = state.episodes.filter((episode) => state.results.has(String(episode.no)));
    if (!done.length) { toast('还没有可导出的译文'); return; }
    const missing = state.episodes.filter((episode) => !state.results.has(String(episode.no))).map((episode) => episode.no);
    if (missing.length && !window.confirm(`${formatEpisodeNumbers(missing)} 还没有翻译，导出的剧本里这些集会保留中文原文。继续导出吗？`)) return;
    const indexesByNo = episodeIndexes(state.paragraphs, state.validation && state.validation.marks);
    const episodes = [];
    const translations = {};
    for (const episode of done) {
      const found = indexesByNo.get(episode.no);
      const paragraphIndexes = found ? found.indexes : [];
      const text = paragraphIndexes.map((index) => state.paragraphs[index]).join('\n').trim();
      if (!text) continue;
      episodes.push({ episode: episode.no, text, paragraphIndexes });
      translations[episode.no] = state.results.get(String(episode.no)).text;
    }
    $('exportTranslate').disabled = true;
    try {
      // 译文由页面一并提交：不依赖服务器上的任务是否还在（重启、过期、分批翻译都能导出）
      const response = await jsonRequest('/api/translate/export', {
        name: state.name, paragraphs: state.paragraphs, episodes, translations,
        targetLanguage: $('targetLanguage').value, mode: $('exportMode').value,
      });
      const blob = await response.blob();
      const href = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = href; a.download = `${state.name || '剧本'}_${$('targetLanguage').value}_翻译.docx`; a.click();
      setTimeout(() => URL.revokeObjectURL(href), 1500);
      state.exported = true;
      toast(missing.length ? `已导出（${missing.length} 集未翻译，保留原文）` : '已开始下载翻译后的整本剧本');
    } catch (error) { showError(error.message || '导出失败'); }
    finally { renderResults(); }
  }

  function guardLeave(action) {
    if (state.busy) { toast(`翻译进行中，请先点「停止」或等它完成再${action}`); return false; }
    if (state.results.size && !state.exported && !window.confirm(`当前剧本已翻译的 ${state.results.size} 集还没有导出，${action}会丢失它们。继续吗？`)) return false;
    return true;
  }

  async function loadFile(file) {
    if (!file || !EXT_RE.test(file.name)) { toast('仅支持 .docx、.txt、.md 文件'); return; }
    if (!guardLeave('导入新剧本')) return;
    stopStream(); state.file = file; state.name = file.name.replace(/\.[^.]+$/, ''); state.paragraphs = []; state.validation = null;
    state.episodes = []; state.missingEpisodes = []; state.sourceEpisodes = []; state.activeSourceKey = ''; teardownSourceScroll(); state.selected.clear(); state.results.clear(); state.errors.clear(); state.exported = false; stopTimer(); state.jobId = ''; state.busy = false; state.done = false; state.batchFailed = false; state.pollStarted = false;
    $('jobProgress').hidden = true;
    $('workspace').hidden = false; $('hint').hidden = true; $('resultCard').hidden = true; $('emptyResult').hidden = false; clearError();
    renderFile(); renderEpisodes(); updateProgress('读取剧本', 0);
    try {
      const response = await request('/api/validate', {
        method: 'POST',
        headers: { 'X-Filename': encodeURIComponent(file.name), 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      const body = await response.json();
      state.validation = body; state.paragraphs = Array.isArray(body.paragraphs) ? body.paragraphs : [];
      state.name = body.name || state.name;
      const raw = body.analysis && Array.isArray(body.analysis.episodes) ? body.analysis.episodes : [];
      state.episodes = normalizeEpisodes(raw, state.paragraphs, body.marks);
      state.missingEpisodes = missingEpisodeNumbers(state.episodes);
      state.episodes.forEach((episode) => state.statuses.set(episode.key, 'idle'));
      if (!state.episodes.length) showError('没有定位到「正文内容」下的有效分集；请检查正文标题和集号。');
      renderFile(); renderEpisodes(); renderSourcePreview(); updateProgress('准备翻译', 0);
      toast(state.episodes.length ? `已识别正文 ${state.episodes.length} 集` : '未识别到正文集');
    } catch (error) {
      showError(error.message || '剧本读取失败');
      renderFile(); renderEpisodes(); updateProgress('读取失败', 0);
    }
  }

  function clearScript() {
    if (!guardLeave('清空')) return;
    stopStream(); stopTimer(); state.errors.clear(); state.exported = false; teardownSourceScroll(); state.file = null; state.name = ''; state.paragraphs = []; state.validation = null; state.episodes = []; state.missingEpisodes = []; state.sourceEpisodes = []; state.activeSourceKey = '';
    state.selected.clear(); state.results.clear(); state.jobId = ''; state.busy = false; state.done = false; state.batchFailed = false; state.pollStarted = false;
    $('workspace').hidden = true; $('hint').hidden = false; $('file').value = ''; $('sourceCard').hidden = true; $('sourceScroll').innerHTML = ''; clearError();
  }

  function updateModelHint() {
    const info = state.models;
    const item = info && info.models.find((m) => m.key === $('model').value);
    const hint = $('modelHint');
    if (!item) { hint.textContent = '模型密钥由服务器管理，浏览器只提交模型名称。'; return; }
    const region = item.region === 'domestic' ? '国内 · 腾讯云' : '海外 · VAPI 中转';
    hint.innerHTML = item.configured
      ? `<span class="model-hint-ok">●</span> ${esc(item.label)} · ${region} · 密钥已配置`
      : `<span class="model-hint-bad">●</span> ${esc(item.label)} · ${region} · <b>服务器未配置密钥</b>，请换一个模型`;
  }

  async function loadModels() {
    try {
      const response = await request('/api/translate/models', { headers: { Accept: 'application/json' } });
      const info = await response.json();
      state.models = info;
      const byKey = new Map(info.models.map((m) => [m.key, m]));
      for (const option of $('model').options) {
        const m = byKey.get(option.value);
        if (m && !m.configured) { option.disabled = true; option.textContent = `${m.label}（未配置密钥）`; }
      }
      const current = byKey.get($('model').value);
      if (current && !current.configured) {
        const first = info.models.find((m) => m.configured);
        if (first) $('model').value = first.key;
      }
      const banner = $('configBanner');
      if (info.mock) { banner.className = 'config-banner info'; banner.textContent = '当前是演示模式：返回的是模拟译文，不会调用真实模型，也不产生费用。'; banner.hidden = false; }
      else if (!info.coze) { banner.className = 'config-banner'; banner.textContent = '服务器未配置 Coze 工作流凭据（COZE_PAT），暂时无法翻译。请联系管理员配置后刷新页面。'; banner.hidden = false; }
      else if (!info.models.some((m) => m.configured)) { banner.className = 'config-banner'; banner.textContent = '服务器没有配置任何模型密钥，暂时无法翻译。'; banner.hidden = false; }
      else banner.hidden = true;
      updateModelHint(); renderEpisodes();
    } catch (_) { /* 拿不到就保持静态选项，提交时由服务器兜底报错 */ }
  }

  function bind() {
    const drop = $('drop'); const input = $('file');
    drop.addEventListener('click', () => input.click());
    drop.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); input.click(); } });
    input.addEventListener('change', () => loadFile(input.files && input.files[0]));
    ['dragenter', 'dragover'].forEach((name) => drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach((name) => drop.addEventListener(name, () => drop.classList.remove('dragover')));
    // 整页都接收拖拽：松手在页面任意位置都导入，而不是被浏览器当成「打开文件」跳走、丢掉当前进度
    let depth = 0;
    window.addEventListener('dragenter', (event) => { event.preventDefault(); depth++; document.body.classList.add('dragging'); });
    window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging'); } });
    window.addEventListener('dragover', (event) => event.preventDefault());
    window.addEventListener('drop', (event) => {
      event.preventDefault(); depth = 0; document.body.classList.remove('dragging');
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) loadFile(file);
    });
    window.addEventListener('beforeunload', (event) => {
      if (state.busy || (state.results.size && !state.exported)) { event.preventDefault(); event.returnValue = ''; }
    });
    $('chooseAgain').addEventListener('click', () => input.click());
    $('clearScript').addEventListener('click', clearScript);
    $('selectAll').addEventListener('change', (event) => {
      if (state.busy) { renderEpisodes(); return; }
      const completed = state.episodes.filter((episode) => episode.status === 'done');
      if (event.target.checked && completed.length
        && !window.confirm(`已有 ${completed.length} 集翻译完成，重新选择会重新翻译这些集，继续吗？`)) {
        renderEpisodes();
        return;
      }
      if (event.target.checked) state.episodes.forEach((episode) => state.selected.add(episode.key));
      else state.selected.clear();
      renderEpisodes();
      });
    $('selectPending').addEventListener('click', () => {
      if (state.busy) return;
      state.selected.clear(); state.episodes.filter((episode) => episode.status !== 'done').forEach((episode) => state.selected.add(episode.key));
      renderEpisodes();
    });
    $('episodeList').addEventListener('change', (event) => {
      if (state.busy) { renderEpisodes(); return; }
      const key = event.target && event.target.dataset && event.target.dataset.episodeKey;
      if (!key) return;
      const episode = state.episodes.find((item) => item.key === key);
      if (event.target.checked && episode?.status === 'done'
        && !window.confirm(`第${episode.no}集已经翻译完成，重新选择会重新翻译，继续吗？`)) {
        renderEpisodes();
        return;
      }
      if (event.target.checked) state.selected.add(key); else state.selected.delete(key);
      renderEpisodes();
    });
    $('episodeList').addEventListener('click', (event) => {
      if (event.target && event.target.closest('input')) return;
      const row = event.target && event.target.closest('.episode-row');
      if (row) sourceScrollTo(row.dataset.episodeKey);
    });
    $('startTranslate').addEventListener('click', startTranslation);
    $('exportTranslate').addEventListener('click', exportTranslation);
    $('stopTranslate').addEventListener('click', stopTranslation);
    $('retryFailed').addEventListener('click', () => {
      if (state.busy) return;
      state.selected.clear();
      state.episodes.filter((episode) => episode.status === 'error').forEach((episode) => state.selected.add(episode.key));
      renderEpisodes(); startTranslation();
    });
    $('resultList').addEventListener('click', async (event) => {
      const button = event.target && event.target.closest('[data-copy-ep]');
      if (!button) return;
      event.preventDefault(); event.stopPropagation();
      const entry = state.results.get(String(button.dataset.copyEp));
      if (entry) toast((await copyText(entry.text)) ? `已复制第${entry.no}集译文` : '复制失败，请手动选择译文复制');
    });
    // 记住上次的语言 / 模型 / 导出方式 / 说明折叠状态
    for (const [id, key] of [['targetLanguage', 'lang'], ['model', 'model'], ['exportMode', 'mode']]) {
      const saved = store.get(key);
      if (saved && [...$(id).options].some((o) => o.value === saved && !o.disabled)) $(id).value = saved;
      $(id).addEventListener('change', () => { store.set(key, $(id).value); updateModelHint(); renderEpisodes(); });
    }
    const guide = $('guideCard');
    if (store.get('guide') === 'closed') guide.open = false;
    guide.addEventListener('toggle', () => store.set('guide', guide.open ? 'open' : 'closed'));
    loadModels();
    $('logout').addEventListener('click', async () => { await fetch('/api/logout', { method: 'POST' }).catch(() => {}); location.href = '/login'; });
    fetch('/api/me').then((response) => response.ok ? response.json() : null).then((body) => { if (body && body.auth) $('logout').hidden = false; }).catch(() => {});
  }

  bind(); renderFile(); renderEpisodes(); renderResults();
})();
