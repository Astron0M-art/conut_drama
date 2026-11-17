// 批量翻译任务：正文逐集调用本项目内的 Coze + 模型适配器，或在本地 mock 烟测。
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const fmt = require('./format');
const zip = require('./format/zip');
const { stripTranslations } = require('./translations');
const {
  translateWithCozeAndModel,
  MODEL_OPTIONS,
  MODEL_ALIASES: PROVIDER_MODEL_ALIASES,
  getModelSpec,
  modelAvailability,
  LEVELS: LANGUAGE_LEVELS,
} = require('./translation-provider');

const MAX_PARAGRAPHS = 200000;
// 单次最多接收 100 集；任务内部以 20 集为并发窗口，其余保持排队状态。
const MAX_EPISODES = 100;
const MAX_CONCURRENT_EPISODES = 20;
const MAX_TEXT_CHARS = 20 * 1024 * 1024;
const MAX_JOBS = 24;
const MAX_RETAINED_JOBS = 40; // 已结束的任务最多留 40 个（每个都带整本剧本），超出按时间淘汰最旧的
// 所有任务共用的上游并发上限，避免多个任务叠加把供应商打到 429；单任务窗口仍是 20
const GLOBAL_CONCURRENCY = Math.max(20, Number(process.env.TRANSLATION_GLOBAL_CONCURRENCY) || 40);
const JOB_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_SERVICE_URL = 'http://127.0.0.1:8023/internal/v2/generations/stream';
const DEFAULT_TIMEOUT_MS = 180000;

// 前端只能传这些 key；真实 provider、URL 和密钥始终留在服务端。
const MODEL_KEYS = Object.freeze(Object.fromEntries(MODEL_OPTIONS.map((item) => [item.key, {
  key: item.key,
  label: item.label,
  provider: item.provider,
  series: item.series,
  slot: item.slot,
  downstream: item.provider === 'tencentcloud' ? 'domestic' : `overseas_series${item.series || 1}`,
}])));

const MODEL_ALIASES = Object.freeze({ ...PROVIDER_MODEL_ALIASES });

const ALLOWED_FLOWS = new Set(['original', 'rewrite', 'novel_adaptation']);
const ALLOWED_DRAMA_TYPES = new Set([
  'animeShortDrama', 'jpAIDrama', 'krAIDrama', 'liveActionShortDrama', 'overseaAIDrama',
]);

function errorWithStatus(message, status = 400, code = 'invalid_translation_request') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function canonicalLanguage(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (LANGUAGE_LEVELS[text]) return text;
  const found = Object.entries(LANGUAGE_LEVELS).find(([, level]) => level === text);
  return found ? found[0] : '';
}

function canonicalModel(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  const key = MODEL_KEYS[normalized] ? normalized : MODEL_ALIASES[normalized];
  return key ? MODEL_KEYS[key] : null;
}

function safeText(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw errorWithStatus(`${name} 必须是非空文本`);
  }
  return value;
}

function normalizedLines(text) {
  return String(text).split(/\r?\n/).map((line) => line.trim());
}

function sameText(a, b) {
  return normalizedLines(a).join('\n') === normalizedLines(b).join('\n');
}

function findParagraphIndexes(paragraphs, text, from = 0) {
  const source = normalizedLines(text);
  if (!source.length) return null;
  for (let i = Math.max(0, from); i <= paragraphs.length - source.length; i++) {
    let ok = true;
    for (let j = 0; j < source.length; j++) {
      if (String(paragraphs[i + j]).trim() !== source[j]) { ok = false; break; }
    }
    if (ok) return Array.from({ length: source.length }, (_, j) => i + j);
  }
  // 允许 episode.text 是正文段落的连接版本，忽略空段和行内空白差异。
  const compact = source.filter(Boolean).join('\n');
  for (let i = Math.max(0, from); i < paragraphs.length; i++) {
    let joined = '';
    const indexes = [];
    for (let j = i; j < paragraphs.length; j++) {
      const part = String(paragraphs[j]).trim();
      if (!part) continue;
      joined += (joined ? '\n' : '') + part;
      indexes.push(j);
      if (joined === compact) return indexes;
      if (joined.length > compact.length) break;
    }
  }
  return null;
}

function normalizeIndexes(value, length, episode) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || !value.length || value.length > 200000) {
    throw errorWithStatus(`第${episode}集 paragraphIndexes 必须是非空整数数组`);
  }
  let previous = -1;
  const indexes = value.map((n) => {
    if (!Number.isInteger(n) || n < 0 || n >= length || n <= previous) {
      throw errorWithStatus(`第${episode}集 paragraphIndexes 含无效或非递增索引`);
    }
    previous = n;
    return n;
  });
  return indexes;
}

function normalizePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw errorWithStatus('请求体必须是对象');
  }
  const name = typeof payload.name === 'string' ? payload.name.slice(0, 200) : '剧本';
  if (!Array.isArray(payload.paragraphs) || payload.paragraphs.length > MAX_PARAGRAPHS
      || payload.paragraphs.some((item) => typeof item !== 'string')) {
    throw errorWithStatus(`paragraphs 必须是最多 ${MAX_PARAGRAPHS} 项的字符串数组`);
  }
  const paragraphs = payload.paragraphs.slice();
  if (!paragraphs.length) throw errorWithStatus('paragraphs 不能为空');
  const totalChars = paragraphs.reduce((sum, item) => sum + item.length, 0);
  if (totalChars > MAX_TEXT_CHARS) throw errorWithStatus('剧本文本超过翻译接口 20MB 限制', 413, 'translation_text_too_large');
  if (!Array.isArray(payload.episodes) || !payload.episodes.length || payload.episodes.length > MAX_EPISODES) {
    throw errorWithStatus(`episodes 必须是 1-${MAX_EPISODES} 项数组`);
  }
  const language = canonicalLanguage(payload.targetLanguage);
  if (!language) throw errorWithStatus(`targetLanguage 只支持：${Object.keys(LANGUAGE_LEVELS).join('、')}`);
  const model = canonicalModel(payload.modelKey);
  if (!model) throw errorWithStatus('modelKey 不在允许的模型白名单中');
  const flow = payload.flow === undefined ? 'original' : payload.flow;
  if (typeof flow !== 'string' || !ALLOWED_FLOWS.has(flow)) {
    throw errorWithStatus('flow 只支持 original、rewrite、novel_adaptation');
  }
  const dramaType = payload.dramaType === undefined ? 'animeShortDrama' : payload.dramaType;
  if (typeof dramaType !== 'string' || !ALLOWED_DRAMA_TYPES.has(dramaType)) {
    throw errorWithStatus('dramaType 不在已发布的剧本类型白名单中');
  }
  const episodes = payload.episodes.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw errorWithStatus(`episodes[${index}] 必须是对象`);
    }
    const episode = Number(item.episode);
    if (!Number.isInteger(episode) || episode < 1 || episode > 100000) {
      throw errorWithStatus(`episodes[${index}].episode 必须是正整数`);
    }
    const rawText = safeText(item.text, `第${episode}集 text`);
    // 中文正文中已有的西/英等括号译文不应再次送入模型；英文原稿只按显式语言标签剥离，
    // 避免把英文动作括号误判成已有翻译。导出仍保留原始 paragraphs。
    const text = /\p{Script=Han}/u.test(rawText)
      ? stripTranslations(rawText)
      : stripTranslations(rawText, { labelledOnly: true });
    const paragraphIndexes = normalizeIndexes(item.paragraphIndexes, paragraphs.length, episode);
    // 保留未过滤的原文用于导出定位；发送给模型的 text 仍会先去掉双语括号译文。
    return { episode, text, sourceText: rawText, paragraphIndexes, sourceIndex: index };
  });
  const duplicate = new Set();
  for (const item of episodes) {
    if (duplicate.has(item.episode)) throw errorWithStatus(`第${item.episode}集重复提交`);
    duplicate.add(item.episode);
  }
  episodes.sort((a, b) => a.episode - b.episode);
  return {
    name: name || '剧本', paragraphs, episodes, language, targetLanguage: language,
    targetLevel: LANGUAGE_LEVELS[language], model, flow, dramaType,
  };
}

function mockTranslation(text, language, episode) {
  const tag = `MOCK-${language}`;
  return `<第${episode}集>\n` + String(text).split(/\r?\n/).map((line) => {
    if (!line.trim()) return line;
    return `${line} 【${tag}】`;
  }).join('\n');
}

function parseSseBlock(block, state) {
  let event = '';
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return;
  const raw = data.join('\n');
  if (raw === '[DONE]') { state.done = true; return; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return; }
  if (event === 'error' || parsed.event === 'error') {
    const message = parsed?.data?.message || parsed?.message || 'StoryPlay 翻译流返回错误';
    throw errorWithStatus(message, 502, 'translation_bridge_failed');
  }
  if (parsed.event === 'text_chunk' && typeof parsed.data?.text === 'string') state.text += parsed.data.text;
  if (parsed.event === 'workflow_finished' && parsed.data?.status && parsed.data.status !== 'succeeded') {
    throw errorWithStatus('StoryPlay 翻译任务未成功结束', 502, 'translation_bridge_failed');
  }
}

async function readSseResponse(response) {
  if (!response.body) throw errorWithStatus('StoryPlay 翻译服务没有返回响应流', 502, 'translation_bridge_failed');
  const state = { text: '', done: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    buffer += decoder.decode(item.value, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || '';
    for (const block of blocks) parseSseBlock(block, state);
  }
  buffer += decoder.decode();
  if (buffer.trim()) parseSseBlock(buffer, state);
  if (!state.text.trim()) throw errorWithStatus('StoryPlay 翻译服务没有返回正文', 502, 'translation_empty_output');
  return state.text;
}

async function bridgeTranslation(episode, job, config) {
  if (config.mock) return mockTranslation(episode.text, job.targetLanguage, episode.episode);
  try {
    const cozeToken = process.env.STORYPLAY_COZE_API_TOKEN || process.env.COZE_PAT || process.env.STORYPLAY_COZE_PAT;
    const spec = getModelSpec(job.model.key);
    const modelToken = spec.provider === 'tencentcloud'
      ? process.env.STORYPLAY_TENCENCLOUD_API_KEY
      : (spec.provider === 'relayrouter'
        ? process.env.STORYPLAY_RELAYROUTER_API_KEY
        : process.env.STORYPLAY_VAPI_API_KEY);
    if (!cozeToken || !modelToken) {
      throw errorWithStatus('未配置翻译服务凭据：请设置 Coze 与所选模型的服务密钥', 503, 'translation_bridge_not_configured');
    }
    // Coze workflow 在本项目内只负责组合 system/user，随后由同一进程调用所选模型。
    // 不依赖外部 dev_cozy 服务；私有 token 仅从运行环境读取。
    return await translateWithCozeAndModel(episode, job, { timeoutMs: config.timeoutMs });
  } catch (error) {
    if (error?.status) throw error;
    throw errorWithStatus(`正文翻译失败：${error.message || '供应商异常'}`, 502, 'translation_provider_failed');
  }
}

function xmlEscape(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function plainDocx(paragraphs) {
  const ref = path.join(__dirname, 'format', 'reference.docx');
  const files = new Map(zip.readAll(fs.readFileSync(ref)));
  const doc = files.get('word/document.xml').toString('utf8');
  const bodyStart = doc.indexOf('<w:body>');
  const sectStart = doc.indexOf('<w:sectPr');
  if (bodyStart < 0 || sectStart < 0) throw new Error('参考 DOCX 模板结构无效');
  const body = paragraphs.map((paragraph) => {
    const lines = String(paragraph).split(/\r?\n/);
    const runs = lines.map((line, index) => `${index ? '<w:br/>' : ''}<w:t xml:space="preserve">${xmlEscape(line)}</w:t>`).join('');
    return `<w:p><w:r>${runs}</w:r></w:p>`;
  }).join('');
  files.set('word/document.xml', Buffer.from(`${doc.slice(0, bodyStart + 8)}${body}${doc.slice(sectStart)}`, 'utf8'));
  return zip.writeAll(files);
}

function episodeInsertIndexes(job) {
  let cursor = 0;
  return job.episodes.map((episode) => {
    let indexes = episode.paragraphIndexes;
    if (!indexes) indexes = findParagraphIndexes(job.paragraphs, episode.sourceText || episode.text, cursor);
    if (!indexes) indexes = [];
    if (indexes.length) cursor = indexes[indexes.length - 1] + 1;
    return { ...episode, resolvedIndexes: indexes };
  });
}

function replaceTranslatedParagraphs(job) {
  const entries = episodeInsertIndexes(job).map((episode, order) => {
    const translation = job.translations.get(episode.episode);
    if (!translation) return null;
    const indexes = episode.resolvedIndexes;
    if (!indexes.length) return null;
    const start = indexes[0];
    const end = indexes[indexes.length - 1];
    const sourceLines = job.paragraphs.slice(start, end + 1);
    const sourceTitle = sourceLines.find((line) =>
      /^\s*(?:第\s*[0-9０-９一二两三四五六七八九十百〇零]+\s*集|<\s*第\s*[0-9０-９一二两三四五六七八九十百〇零]+\s*集\s*>)/.test(String(line || '')),
    );
    let translationLines = String(translation).split(/\r?\n/);
    const wrapperPattern = new RegExp(`^\\s*(?:<\\s*)?(?:【译文[^】]*】\\s*)?第\\s*${episode.episode}\\s*集(?:\\s*>.*|\\s*：.*|\\s*$)`);
    const firstContent = translationLines.findIndex((line) => String(line || '').trim());
    if (firstContent >= 0 && wrapperPattern.test(String(translationLines[firstContent]).trim())) {
      translationLines = translationLines.slice(0, firstContent).concat(translationLines.slice(firstContent + 1));
    }
    while (translationLines.length && !String(translationLines[0]).trim()) translationLines.shift();
    while (translationLines.length && !String(translationLines[translationLines.length - 1]).trim()) translationLines.pop();
    const hasTitle = translationLines.some((line) =>
      /^\s*(?:第\s*[0-9０-９一二两三四五六七八九十百〇零]+\s*集|<\s*第\s*[0-9０-９一二两三四五六七八九十百〇零]+\s*集\s*>)/.test(String(line || '')),
    );
    if (sourceTitle && !hasTitle) translationLines.unshift(String(sourceTitle));
    return { start, end, order, lines: translationLines };
  }).filter(Boolean).sort((a, b) => b.start - a.start || b.order - a.order);
  const out = job.paragraphs.slice();
  for (const entry of entries) out.splice(entry.start, entry.end - entry.start + 1, ...entry.lines);
  return out;
}

function appendTranslatedParagraphs(job) {
  const entries = episodeInsertIndexes(job).map((episode, order) => {
    const translation = job.translations.get(episode.episode);
    if (!translation) return null;
    const insertAt = episode.resolvedIndexes.length
      ? episode.resolvedIndexes[episode.resolvedIndexes.length - 1] + 1
      : job.paragraphs.length;
    let translationLines = String(translation).split(/\r?\n/);
    const titlePattern = new RegExp(`^(?:<\\s*)?第\\s*${episode.episode}\\s*集(?:>|\\s*>|\\s*$|\\s+.+$)`);
    for (let pass = 0; pass < 2; pass++) {
      const first = translationLines.findIndex((line) => line.trim());
      if (first < 0 || !titlePattern.test(translationLines[first].trim())) break;
      translationLines = translationLines.slice(0, first).concat(translationLines.slice(first + 1));
    }
    const lines = [`【译文·${job.targetLanguage}】第${episode.episode}集`, ...translationLines, ''];
    return { insertAt, order, lines };
  }).filter(Boolean).sort((a, b) => b.insertAt - a.insertAt || b.order - a.order);
  const out = job.paragraphs.slice();
  for (const entry of entries) out.splice(entry.insertAt, 0, ...entry.lines);
  return out;
}

function translatedParagraphs(job, mode = 'replace') {
  return mode === 'bilingual' ? appendTranslatedParagraphs(job) : replaceTranslatedParagraphs(job);
}

function exportJob(job, options = {}) {
  const missingEpisodes = job.episodes
    .filter((episode) => !job.translations.has(episode.episode))
    .map((episode) => episode.episode);
  if (job.status !== 'succeeded' || missingEpisodes.length) {
    const error = errorWithStatus(
      missingEpisodes.length
        ? `以下集尚未完成翻译，不能导出整本剧本：${missingEpisodes.map((episode) => `第${episode}集`).join('、')}`
        : '翻译尚未完成，暂不能导出',
      409,
      missingEpisodes.length ? 'translation_incomplete' : 'translation_not_ready',
    );
    error.missingEpisodes = missingEpisodes;
    throw error;
  }
  const mode = options.mode === 'bilingual' ? 'bilingual' : 'replace';
  const paragraphs = translatedParagraphs(job, mode);
  try {
    return { paragraphs, buffer: fmt.exportDocx(paragraphs) };
  } catch {
    // 源稿的版式可能尚未通过标准校验；翻译导出仍保留全文和译文，使用同一参考模板的纯段落回退。
    return { paragraphs, buffer: plainDocx(paragraphs) };
  }
}

function createTranslationManager(options = {}) {
  const jobs = new Map();
  const config = {
    mock: options.mock ?? /^(1|true|yes|on)$/i.test(process.env.TRANSLATION_MOCK || ''),
    url: options.url || process.env.TRANSLATION_SERVICE_URL || DEFAULT_SERVICE_URL,
    token: options.token || process.env.TRANSLATION_SERVICE_TOKEN || process.env.STORYPLAY_INTERNAL_BEARER_TOKEN || '',
    timeoutMs: Math.max(1000, Number(options.timeoutMs || process.env.TRANSLATION_SERVICE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS),
    bridge: typeof options.bridge === 'function' ? options.bridge : bridgeTranslation,
  };
  const clean = () => {
    const now = Date.now();
    for (const [id, job] of jobs) if (job.finishedAt && now - job.finishedAt > JOB_TTL_MS) jobs.delete(id);
    const finished = [...jobs.values()].filter((job) => job.finishedAt).sort((a, b) => a.finishedAt - b.finishedAt);
    for (const job of finished.slice(0, Math.max(0, finished.length - MAX_RETAINED_JOBS))) jobs.delete(job.id);
  };
  // 跨任务并发闸门：先到先得，释放时唤醒下一个等待者
  let gateActive = 0;
  const gateWaiters = [];
  const gate = {
    acquire() {
      if (gateActive < GLOBAL_CONCURRENCY) { gateActive += 1; return Promise.resolve(); }
      return new Promise((resolve) => gateWaiters.push(resolve));
    },
    release() {
      const next = gateWaiters.shift();
      if (next) next(); else gateActive = Math.max(0, gateActive - 1);
    },
  };
  const emit = (job, type, data) => {
    const event = {
      type, ...data, jobId: job.id, status: job.status,
      completed: job.completed, failed: job.failed, queued: job.queued,
      running: job.running, total: job.episodes.length,
    };
    job.events.push(event);
    for (const listener of job.listeners) {
      try { listener(event); } catch { job.listeners.delete(listener); }
    }
    if (job.events.length > 4000) job.events.splice(0, job.events.length - 4000);
  };
  const run = async (job) => {
    job.status = 'running';
    emit(job, 'job_started', { modelKey: job.model.key, targetLanguage: job.targetLanguage });
    const queue = job.episodes.slice();
    const worker = async () => {
      while (queue.length && !job.cancelled) {
        const episode = queue.shift();
        if (!episode) return;
        await gate.acquire();
        if (job.cancelled) { gate.release(); queue.unshift(episode); return; }
        job.queued = Math.max(0, job.queued - 1);
        job.running += 1;
        job.currentEpisode = episode.episode;
        job.episodeStatuses.set(episode.episode, 'running');
        emit(job, 'episode_started', { episode: episode.episode });
        try {
          const text = await config.bridge(episode, job, config);
          job.translations.set(episode.episode, text);
          job.completed += 1;
          job.episodeStatuses.set(episode.episode, 'done');
          emit(job, 'episode_completed', { episode: episode.episode, translation: text });
        } catch (error) {
          // 单集失败只记录该集并让 worker 继续取下一集，不能中断其它并发请求。
          job.failed += 1;
          job.episodeStatuses.set(episode.episode, 'error');
          const detail = {
            code: error?.code || 'translation_failed',
            message: error?.message || '翻译失败',
            episode: episode.episode,
          };
          job.errors.set(episode.episode, detail);
          emit(job, 'episode_failed', { episode: episode.episode, error: detail });
        } finally {
          job.running = Math.max(0, job.running - 1);
          gate.release();
        }
      }
    };
    const workerCount = Math.min(MAX_CONCURRENT_EPISODES, job.episodes.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    job.finishedAt = Date.now();
    if (job.cancelled) {
      // 用户主动停止：已在途的集会跑完并保留译文，没开始的集回到「待翻译」
      const cancelled = queue.map((episode) => episode.episode);
      for (const no of cancelled) job.episodeStatuses.set(no, 'idle');
      job.queued = 0;
      job.status = 'cancelled';
      emit(job, 'job_cancelled', { ok: false, cancelledEpisodes: cancelled });
    } else if (job.failed) {
      job.status = 'failed';
      const failures = [...job.errors.values()];
      // 全部集都因同一配置/凭据问题失败时保留原错误码，兼容单集调用方；
      // 只要有成功结果，就使用批量部分失败码，表示其它集已继续完成。
      const allFailedSame = job.completed === 0 && failures.length === job.episodes.length
        && failures.length > 0 && failures.every((item) => item.code === failures[0].code);
      job.error = allFailedSame
        ? { ...failures[0], episodes: failures }
        : {
          code: 'translation_batch_partial_failed',
          message: `${job.failed} 集翻译失败，其余集已完成或仍可重试`,
          episodes: failures,
        };
      emit(job, 'job_failed', { ok: false, error: job.error, failedEpisodes: [...job.errors.values()] });
    } else {
      job.status = 'succeeded';
      emit(job, 'job_completed', { ok: true });
    }
    for (const listener of job.listeners) {
      try { listener(null); } catch { /* 客户端断开不应影响任务终态 */ }
    }
    job.listeners.clear();
  };
  return {
    start(payload) {
      clean();
      const active = [...jobs.values()].filter((job) => job.status === 'queued' || job.status === 'running').length;
      if (active >= MAX_JOBS) throw errorWithStatus('翻译任务过多，请稍后再试', 503, 'translation_jobs_busy');
      const input = normalizePayload(payload);
      const id = crypto.randomBytes(12).toString('hex');
      const job = {
        id, ...input, status: 'queued', completed: 0, currentEpisode: null, error: null,
        failed: 0, queued: input.episodes.length, running: 0, cancelled: false,
        translations: new Map(), errors: new Map(),
        episodeStatuses: new Map(input.episodes.map((episode) => [episode.episode, 'queued'])),
        events: [], listeners: new Set(), createdAt: Date.now(), finishedAt: null,
      };
      jobs.set(id, job);
      void run(job);
      return { jobId: id, status: job.status, total: job.episodes.length, targetLanguage: job.targetLanguage, modelKey: job.model.key };
    },
    get(id) { clean(); return jobs.get(id) || null; },
    // 停止：不再启动新的集；已发出的请求等它返回（译文照常保留）
    cancel(id) {
      const job = jobs.get(id);
      if (!job) throw errorWithStatus('找不到翻译任务', 404, 'translation_job_not_found');
      if (job.finishedAt) return job;
      job.cancelled = true;
      return job;
    },
    // 开始前先看密钥：缺了就立刻告诉用户，别让整批集一个个失败
    preflight(payload) {
      if (config.mock || config.bridge !== bridgeTranslation) return;
      const model = canonicalModel(payload && payload.modelKey);
      if (!model) return; // 白名单错误由 normalizePayload 报告
      const available = modelAvailability();
      if (!available.coze) throw errorWithStatus('服务器未配置 Coze 工作流凭据，暂时无法翻译', 503, 'translation_bridge_not_configured');
      const item = available.models.find((entry) => entry.key === model.key);
      if (item && !item.configured) throw errorWithStatus(`服务器未配置「${item.label}」的模型密钥，请换一个模型`, 503, 'translation_bridge_not_configured');
    },
    availability() {
      const available = modelAvailability();
      if (!config.mock) return { ...available, mock: false };
      return { coze: true, mock: true, models: available.models.map((item) => ({ ...item, configured: true })) };
    },
    // 无状态导出：页面把已完成的译文连同原稿一起提交，译文不依赖服务器上的任务是否还在
    exportFromPayload(payload) {
      const input = normalizePayload({ ...payload, modelKey: payload && payload.modelKey ? payload.modelKey : 'ds-v4.1-flash' });
      const raw = payload && payload.translations && typeof payload.translations === 'object' ? payload.translations : {};
      const translations = new Map();
      for (const episode of input.episodes) {
        const value = raw[episode.episode] ?? raw[String(episode.episode)];
        if (typeof value === 'string' && value.trim()) translations.set(episode.episode, value);
      }
      if (!translations.size) throw errorWithStatus('没有可导出的译文，请先完成至少一集的翻译', 409, 'translation_empty');
      const missingEpisodes = input.episodes.filter((episode) => !translations.has(episode.episode)).map((episode) => episode.episode);
      const mode = payload && payload.mode === 'bilingual' ? 'bilingual' : 'replace';
      const paragraphs = translatedParagraphs({ ...input, translations }, mode);
      let buffer;
      try { buffer = fmt.exportDocx(paragraphs); } catch { buffer = plainDocx(paragraphs); }
      return { paragraphs, buffer, missingEpisodes, name: input.name, targetLanguage: input.targetLanguage };
    },
    subscribe(id, listener) {
      const job = jobs.get(id);
      if (!job) return null;
      for (const event of job.events) listener(event);
      if (job.finishedAt) listener(null);
      else job.listeners.add(listener);
      return job;
    },
    unsubscribe(id, listener) {
      const job = jobs.get(id);
      if (job) job.listeners.delete(listener);
    },
    export(id, options = {}) {
      clean();
      const job = jobs.get(id);
      if (!job) throw errorWithStatus('找不到翻译任务', 404, 'translation_job_not_found');
      return exportJob(job, options);
    },
    config,
  };
}

module.exports = {
  createTranslationManager,
  MAX_EPISODES,
  MAX_CONCURRENT_EPISODES,
  normalizePayload,
  canonicalLanguage,
  canonicalModel,
  MODEL_KEYS,
  LANGUAGE_LEVELS,
  mockTranslation,
  translatedParagraphs,
};
