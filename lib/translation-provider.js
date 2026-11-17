// 正文翻译供应商：Coze 只编译 system/user，本地 Node 再调用所选模型。
// 这里不依赖 storyPlay_AI-dev_cozy；目标项目只读取运行时环境中的私有密钥。
'use strict';

const COZE_WORKFLOW_ID = '7703551069263347752';
const COZE_SPACE_ID = '7701156456527577088';
const DEFAULT_COZE_ENDPOINT = 'https://api.coze.cn/v1/workflow/stream_run';
const DEFAULT_TENCENT_ENDPOINT = 'https://tokenhub.tencentmaas.com/v1';
const DEFAULT_VAPI_ENDPOINT = 'https://api.gpt.ge/v1';
const DEFAULT_RELAYROUTER_ENDPOINT = 'https://api.relayrouter.ai/v1';

const LEVELS = Object.freeze({
  英语: 'half_english',
  日语: 'half_japan',
  韩语: 'half_korea',
  西班牙语: 'half_spanish',
  葡萄牙语: 'half_portugal',
  阿拉伯语: 'half_arabic',
});

// 只把已经在 StoryPlay 配置中出现过的稳定模型 ID 暴露给正文翻译页。
// 腾讯云网关以 endpoint ID 作为 OpenAI-compatible 的 model 字段；海外中转站
// 直接使用配置中的真实模型 ID。前端只拿到 key/label，不会拿到 endpoint 或密钥。
const MODEL_SPECS = Object.freeze({
  'ds-v4.1-flash': {
    provider: 'tencentcloud',
    keyEnv: 'STORYPLAY_TENCENCLOUD_API_KEY',
    endpointEnv: 'STORYPLAY_TENCENCLOUD_BASE_URL',
    endpoint: DEFAULT_TENCENT_ENDPOINT,
    modelEnv: 'STORYPLAY_TENCENT_TRANSLATION_MODEL',
    model: 'ep-ivmnc5mp',
    label: 'ds-v4.1-flash',
  },
  'ds-v4-flash-0731': {
    provider: 'tencentcloud',
    keyEnv: 'STORYPLAY_TENCENCLOUD_API_KEY',
    endpointEnv: 'STORYPLAY_TENCENCLOUD_BASE_URL',
    endpoint: DEFAULT_TENCENT_ENDPOINT,
    modelEnv: 'STORYPLAY_TENCENT_DS_V4_FLASH_0731_MODEL',
    model: 'ep-zlx8qh0x',
    label: 'ds-v4-flash-0731',
  },
  'glm5.3': {
    provider: 'tencentcloud',
    keyEnv: 'STORYPLAY_TENCENCLOUD_API_KEY',
    endpointEnv: 'STORYPLAY_TENCENCLOUD_BASE_URL',
    endpoint: DEFAULT_TENCENT_ENDPOINT,
    modelEnv: 'STORYPLAY_TENCENT_GLM53_MODEL',
    model: 'ep-7080dfh4',
    label: 'glm5.3',
  },
  'glm5.3-flash': {
    provider: 'tencentcloud',
    keyEnv: 'STORYPLAY_TENCENCLOUD_API_KEY',
    endpointEnv: 'STORYPLAY_TENCENCLOUD_BASE_URL',
    endpoint: DEFAULT_TENCENT_ENDPOINT,
    modelEnv: 'STORYPLAY_TENCENT_GLM53_FLASH_MODEL',
    model: 'ep-hfm70jyn',
    label: 'glm5.3-flash',
  },
  'gemini-4-argon': {
    provider: 'vapi',
    keyEnv: 'STORYPLAY_VAPI_API_KEY',
    endpointEnv: 'STORYPLAY_VAPI_BASE_URL',
    endpoint: DEFAULT_VAPI_ENDPOINT,
    modelEnv: 'STORYPLAY_VAPI_SERIES1_P1',
    model: 'gemini-4-argon',
    label: 'gemini-4-argon',
    series: 1,
    slot: 'P1',
  },
  'gemini-3.8-flash': {
    provider: 'vapi',
    keyEnv: 'STORYPLAY_VAPI_API_KEY',
    endpointEnv: 'STORYPLAY_VAPI_BASE_URL',
    endpoint: DEFAULT_VAPI_ENDPOINT,
    modelEnv: 'STORYPLAY_VAPI_SERIES1_P2',
    model: 'gemini-3.8-flash',
    label: 'gemini-3.8-flash',
    series: 1,
    slot: 'P2',
  },
  'gemini-3.7-flash': {
    provider: 'vapi',
    keyEnv: 'STORYPLAY_VAPI_API_KEY',
    endpointEnv: 'STORYPLAY_VAPI_BASE_URL',
    endpoint: DEFAULT_VAPI_ENDPOINT,
    modelEnv: 'STORYPLAY_VAPI_SERIES1_P3',
    model: 'gemini-3.7-flash',
    label: 'gemini-3.7-flash',
    series: 1,
    slot: 'P3',
  },
  'claude-sonnet-5-5': {
    provider: 'vapi',
    keyEnv: 'STORYPLAY_VAPI_API_KEY',
    endpointEnv: 'STORYPLAY_VAPI_BASE_URL',
    endpoint: DEFAULT_VAPI_ENDPOINT,
    modelEnv: 'STORYPLAY_VAPI_SERIES2_P1',
    model: 'claude-sonnet-5-5',
    label: 'claude-sonnet-5-5',
    series: 2,
    slot: 'P1',
  },
  'claude-sonnet-5': {
    provider: 'vapi',
    keyEnv: 'STORYPLAY_VAPI_API_KEY',
    endpointEnv: 'STORYPLAY_VAPI_BASE_URL',
    endpoint: DEFAULT_VAPI_ENDPOINT,
    modelEnv: 'STORYPLAY_VAPI_SERIES2_P2',
    model: 'claude-sonnet-5',
    label: 'claude-sonnet-5',
    series: 2,
    slot: 'P2',
  },
  'claude-sonnet-4-6': {
    provider: 'vapi',
    keyEnv: 'STORYPLAY_VAPI_API_KEY',
    endpointEnv: 'STORYPLAY_VAPI_BASE_URL',
    endpoint: DEFAULT_VAPI_ENDPOINT,
    modelEnv: 'STORYPLAY_VAPI_SERIES2_P3',
    model: 'claude-sonnet-4-6',
    label: 'claude-sonnet-4-6',
    series: 2,
    slot: 'P3',
  },
  'gpt-6.1-terra': {
    provider: 'vapi',
    keyEnv: 'STORYPLAY_VAPI_API_KEY',
    endpointEnv: 'STORYPLAY_VAPI_BASE_URL',
    endpoint: DEFAULT_VAPI_ENDPOINT,
    modelEnv: 'STORYPLAY_VAPI_SERIES3_P1',
    model: 'gpt-6.1-terra',
    label: 'gpt-6.1-terra',
    series: 3,
    slot: 'P1',
  },
});

const MODEL_ALIASES = Object.freeze({
  deepseek: 'ds-v4.1-flash',
  deepseek_v41: 'ds-v4.1-flash',
  deepseek_v41_tencent: 'ds-v4.1-flash',
  domestic_ds_v41: 'ds-v4.1-flash',
  gemini: 'gemini-4-argon',
  vapi_gemini: 'gemini-4-argon',
  overseas_gemini: 'gemini-4-argon',
  claude: 'claude-sonnet-5-5',
  vapi_claude: 'claude-sonnet-5-5',
  overseas_claude: 'claude-sonnet-5-5',
  gpt: 'gpt-6.1-terra',
  vapi_gpt: 'gpt-6.1-terra',
  overseas_gpt: 'gpt-6.1-terra',
});

const MODEL_OPTIONS = Object.freeze(Object.values(MODEL_SPECS).map((spec) => Object.freeze({
  key: spec.label,
  label: spec.label,
  provider: spec.provider,
  series: spec.series || null,
  slot: spec.slot || null,
})));

function providerError(message, status = 502, code = 'translation_provider_failed') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function envModel(value, fallback) {
  const text = String(value || '').trim();
  if (!text) return fallback;
  // 兼容现有配置中可能出现的 provider:model[:label] 写法。
  const parts = text.split(':');
  return parts.length >= 2 ? parts[1] : parts[0];
}

function getModelSpec(modelKey) {
  const normalized = String(modelKey || '').trim().toLowerCase();
  const key = MODEL_SPECS[normalized] ? normalized : MODEL_ALIASES[normalized];
  const spec = MODEL_SPECS[key];
  if (!spec) throw providerError('modelKey 不在翻译模型白名单中', 400, 'translation_model_invalid');
  const overseasProvider = String(process.env.STORYPLAY_OVERSEAS_PROVIDER || 'vapi').trim().toLowerCase();
  if (spec.provider !== 'vapi' || overseasProvider === 'vapi') {
    return {
      ...spec,
      endpoint: process.env[spec.endpointEnv] || spec.endpoint,
      model: envModel(process.env[spec.modelEnv], spec.model),
      apiKey: process.env[spec.keyEnv] || '',
    };
  }
  if (overseasProvider === 'relayrouter') {
    const series = spec.series || spec.modelEnv.match(/SERIES(\d+)/)?.[1] || '1';
    const slot = spec.slot || 'P1';
    const relayModel = envModel(process.env[`STORYPLAY_RELAYROUTER_SERIES${series}_${slot}`], spec.model);
    return {
      ...spec,
      provider: 'relayrouter',
      endpoint: process.env.STORYPLAY_RELAYROUTER_BASE_URL || DEFAULT_RELAYROUTER_ENDPOINT,
      model: relayModel,
      apiKey: process.env.STORYPLAY_RELAYROUTER_API_KEY || '',
    };
  }
  throw providerError(`不支持的海外模型网关：${overseasProvider}`, 503, 'translation_provider_invalid');
}

const RETRY_DELAYS_MS = [1500, 4000];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const retryableStatus = (status) => status === 429 || status === 500 || status === 502 || status === 503 || status === 504;

// 只重试暂时性故障；凭据缺失、合同不符、被截断等重试也没用，直接抛出
async function withRetry(fn, config = {}) {
  const delays = Array.isArray(config.retryDelays) ? config.retryDelays : RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); } catch (error) {
      if (!error || error.retryable !== true || attempt >= delays.length) throw error;
      await sleep(delays[attempt]);
    }
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw providerError('翻译服务超时', 504, 'translation_provider_timeout');
    const failure = providerError(`翻译服务网络异常：${error.message || '网络错误'}`, 502, 'translation_provider_unavailable');
    failure.retryable = true;
    throw failure;
  } finally {
    clearTimeout(timer);
  }
}

function sseBlocks(text) {
  return String(text || '').split(/\r?\n\r?\n/).map((block) => {
    let event = '';
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    return { event, data: data.join('\n') };
  }).filter((block) => block.data);
}

function parseJson(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
}

function findPrompt(value) {
  const parsed = parseJson(value);
  if (!parsed) return null;
  const candidates = [parsed, parsed.data, parsed.output, parsed.content, parsed.data?.content];
  for (const candidate of candidates) {
    const obj = parseJson(candidate) || candidate;
    if (!obj || typeof obj !== 'object') continue;
    const output = obj.output && typeof obj.output === 'object' ? obj.output : obj;
    if (typeof output.system === 'string' && typeof output.user === 'string') {
      return { system: output.system, user: output.user };
    }
  }
  return null;
}

async function cozePrompt(episode, job, config = {}) {
  const token = config.cozeToken || process.env.STORYPLAY_COZE_API_TOKEN
    || process.env.COZE_PAT || process.env.STORYPLAY_COZE_PAT || '';
  if (!token) throw providerError('未配置 Coze 工作流凭据', 503, 'translation_coze_not_configured');
  const targetLevel = LEVELS[job.targetLanguage] || job.targetLanguage;
  const parameters = { content: episode.text, translateLevel: targetLevel };
  if (config.preEpContent) parameters.preEpContent = config.preEpContent;
  const raw = await withRetry(async () => {
    const response = await fetchWithTimeout(
      config.cozeEndpoint || process.env.STORYPLAY_COZE_V2_ENDPOINT || DEFAULT_COZE_ENDPOINT,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ workflow_id: COZE_WORKFLOW_ID, parameters }),
      },
      config.timeoutMs || 180000,
    );
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      // 上游错误体可能回显入参或供应商私有信息，不透传给浏览器。
      const failure = providerError(`Coze 工作流返回 HTTP ${response.status}`, 502, 'translation_coze_failed');
      failure.retryable = retryableStatus(response.status);
      throw failure;
    }
    return text;
  }, config);
  let prompt = null;
  let errorMessage = '';
  for (const block of sseBlocks(raw)) {
    if (block.data === '[DONE]') continue;
    const parsed = parseJson(block.data);
    if (block.event.toLowerCase() === 'error' || parsed?.error_code) {
      // 错误载荷可能回显工作流入参；只记录安全的阶段说明。
      errorMessage = 'Coze 工作流执行失败';
      continue;
    }
    prompt = findPrompt(parsed) || findPrompt(block.data) || prompt;
  }
  if (!prompt || !prompt.system.trim() || !prompt.user.trim()) {
    throw providerError(errorMessage || 'Coze 未返回完整 system/user 提示词', 502, 'translation_coze_contract_failed');
  }
  return { ...prompt, workflowId: COZE_WORKFLOW_ID, spaceId: COZE_SPACE_ID };
}

function modelMessages(prompt) {
  const messages = [];
  if (prompt.system) messages.push({ role: 'system', content: prompt.system });
  messages.push({ role: 'user', content: prompt.user });
  return messages;
}

async function localModel(prompt, modelKey, config = {}) {
  const spec = getModelSpec(modelKey);
  if (!spec.apiKey) throw providerError(`未配置 ${spec.label} 模型凭据`, 503, 'translation_model_not_configured');
  const data = await withRetry(async () => {
    const response = await fetchWithTimeout(
      `${spec.endpoint.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${spec.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: spec.model,
          messages: modelMessages(prompt),
          stream: false,
          temperature: 0.2,
          max_tokens: Number(process.env.STORYPLAY_TRANSLATION_MAX_TOKENS || 60000),
        }),
      },
      config.timeoutMs || 300000,
    );
    const raw = await response.text();
    if (!response.ok) {
      const failure = providerError(`${spec.label} 返回 HTTP ${response.status}`, 502, 'translation_model_failed');
      failure.retryable = retryableStatus(response.status);
      throw failure;
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw providerError(`${spec.label} 返回不是 JSON`, 502, 'translation_model_contract_failed'); }
    return parsed;
  }, config);
  if (data?.choices?.[0]?.finish_reason === 'length') {
    throw providerError(`${spec.label} 译文被截断（超出模型输出长度），请换模型后重试该集`, 502, 'translation_truncated');
  }
  const value = data?.choices?.[0]?.message?.content ?? data?.output?.text ?? data?.text;
  const text = Array.isArray(value) ? value.map((part) => part?.text || '').join('') : String(value || '');
  if (!text.trim()) {
    const failure = providerError(`${spec.label} 未返回译文`, 502, 'translation_empty_output');
    failure.retryable = true;
    throw failure;
  }
  return text;
}

async function translateWithCozeAndModel(episode, job, config = {}) {
  const prompt = await cozePrompt(episode, job, config);
  // 模型偶发返回空文本：重新请求一次（Coze 提示词已有，不重复调用工作流）
  return withRetry(() => localModel(prompt, job.model.key, config), { retryDelays: [1500] });
}

// 页面用：哪些模型已配置密钥、Coze 是否可用（只返回布尔，绝不返回密钥/地址）
function modelAvailability() {
  const coze = Boolean(process.env.STORYPLAY_COZE_API_TOKEN || process.env.COZE_PAT || process.env.STORYPLAY_COZE_PAT);
  const models = MODEL_OPTIONS.map((option) => {
    let configured = false;
    try { configured = Boolean(getModelSpec(option.key).apiKey); } catch { configured = false; }
    return { key: option.key, label: option.label, region: option.provider === 'tencentcloud' ? 'domestic' : 'overseas', configured };
  });
  return { coze, models };
}

module.exports = {
  COZE_WORKFLOW_ID,
  COZE_SPACE_ID,
  DEFAULT_COZE_ENDPOINT,
  LEVELS,
  MODEL_SPECS,
  MODEL_OPTIONS,
  MODEL_ALIASES,
  getModelSpec,
  cozePrompt,
  localModel,
  translateWithCozeAndModel,
  modelAvailability,
  withRetry,
};
