'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  COZE_WORKFLOW_ID,
  COZE_SPACE_ID,
  cozePrompt,
  localModel,
  getModelSpec,
  MODEL_OPTIONS,
  LEVELS,
} = require('../lib/translation-provider');
const { normalizePayload, LANGUAGE_LEVELS } = require('../lib/translate');

const originalFetch = global.fetch;

test('菲律宾语和马来语归一化后使用准确 Coze 入参，提示词原样保留', async () => {
  assert.strictEqual(LANGUAGE_LEVELS, LEVELS);
  const source = '第1集\n甲：你好。';
  const prompts = { system: '系统提示词\n保持原样。', user: '用户提示词\n{{content}}' };
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(
      `event: Message\ndata: ${JSON.stringify({ content: JSON.stringify({ output: prompts }), node_is_finish: true, node_title: 'End' })}\n\nevent: Done\ndata: {"code":0}\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  };
  try {
    for (const [language, level] of [['菲律宾语', 'filipino'], ['马来语', 'malay']]) {
      assert.equal(LEVELS[language], level);
      for (const input of [language, level]) {
        const job = normalizePayload({
          name: '语言测试', paragraphs: source.split('\n'),
          episodes: [{ episode: 1, text: source, paragraphIndexes: [0, 1] }],
          targetLanguage: input, modelKey: 'ds-v4.1-flash',
        });
        assert.equal(job.targetLanguage, language);
        assert.equal(job.targetLevel, level);
        const prompt = await cozePrompt(job.episodes[0], job, {
          cozeToken: 'coze-test-token', cozeEndpoint: 'https://coze.test/v1/workflow/stream_run', timeoutMs: 1000,
        });
        assert.equal(prompt.system, prompts.system);
        assert.equal(prompt.user, prompts.user);
        assert.equal(requests.at(-1).workflow_id, COZE_WORKFLOW_ID);
        assert.deepEqual(requests.at(-1).parameters, { content: source, translateLevel: level });
      }
    }
    assert.equal(requests.length, 4);
  } finally {
    global.fetch = originalFetch;
  }
});

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test('Coze 工作流只组合提示词，并使用默认 workflow/space 常量', async () => {
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    const body = JSON.stringify({ output: { system: '系统提示词', user: '用户提示词' } });
    const stream = [
      `event: Message\ndata: ${JSON.stringify({ content: body, node_is_finish: true, node_title: 'End' })}`,
      'event: Done\ndata: {"code":0}',
    ].join('\n\n') + '\n\n';
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const prompt = await cozePrompt(
      { text: '第1集\n甲：你好。' },
      { targetLanguage: '英语' },
      { cozeToken: 'coze-test-token', cozeEndpoint: 'https://coze.test/v1/workflow/stream_run', timeoutMs: 1000 },
    );
    assert.equal(prompt.system, '系统提示词');
    assert.equal(prompt.user, '用户提示词');
    assert.equal(prompt.workflowId, COZE_WORKFLOW_ID);
    assert.equal(prompt.spaceId, COZE_SPACE_ID);
    assert.equal(request.url, 'https://coze.test/v1/workflow/stream_run');
    const body = JSON.parse(request.options.body);
    assert.equal(body.workflow_id, COZE_WORKFLOW_ID);
    assert.deepEqual(body.parameters, { content: '第1集\n甲：你好。', translateLevel: 'half_english' });
    assert.equal(request.options.headers.Authorization, 'Bearer coze-test-token');
  } finally {
    global.fetch = originalFetch;
  }
});

test('本地模型收到 Coze 原样 system/user，并按模型 key 选择配置', async () => {
  const keys = [
    'STORYPLAY_VAPI_API_KEY', 'STORYPLAY_VAPI_BASE_URL',
    'STORYPLAY_VAPI_SERIES2_P1', 'STORYPLAY_OVERSEAS_PROVIDER',
  ];
  const snapshot = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  let request;
  Object.assign(process.env, {
    STORYPLAY_VAPI_API_KEY: 'model-test-token',
    STORYPLAY_VAPI_BASE_URL: 'https://vapi.test/v1',
    STORYPLAY_VAPI_SERIES2_P1: 'claude-test-model',
    STORYPLAY_OVERSEAS_PROVIDER: 'vapi',
  });
  global.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ choices: [{ message: { content: '译文结果' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const result = await localModel({ system: '系统提示词', user: '用户提示词' }, 'claude-sonnet-5-5', { timeoutMs: 1000 });
    assert.equal(result, '译文结果');
    assert.equal(request.url, 'https://vapi.test/v1/chat/completions');
    assert.equal(request.options.headers.Authorization, 'Bearer model-test-token');
    const body = JSON.parse(request.options.body);
    assert.equal(body.model, 'claude-test-model');
    assert.deepEqual(body.messages, [
      { role: 'system', content: '系统提示词' },
      { role: 'user', content: '用户提示词' },
    ]);
  } finally {
    global.fetch = originalFetch;
    restoreEnv(snapshot);
  }
});

test('模型白名单暴露真实 ID，并保留旧简称兼容映射', () => {
  assert.deepEqual(MODEL_OPTIONS.map((item) => item.key), [
    'ds-v4.1-flash', 'ds-v4-flash-0731', 'glm5.3', 'glm5.3-flash',
    'gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.7-flash',
    'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6', 'gpt-6.1-terra',
  ]);
  assert.equal(getModelSpec('deepseek').label, 'ds-v4.1-flash');
  assert.equal(getModelSpec('gemini').label, 'gemini-4-argon');
  assert.equal(getModelSpec('claude').label, 'claude-sonnet-5-5');
  assert.equal(getModelSpec('gpt').label, 'gpt-6.1-terra');
  assert.equal(getModelSpec('glm5.3-flash').model, 'ep-hfm70jyn');
});

test('Coze 错误流不把上游私有载荷回显给页面', async () => {
  global.fetch = async () => new Response(
    'event: Error\ndata: {"message":"PRIVATE_SCRIPT_INPUT"}\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
  try {
    await assert.rejects(
      cozePrompt({ text: '原文' }, { targetLanguage: '英语' }, { cozeToken: 'coze-test-token', timeoutMs: 1000 }),
      (error) => error.code === 'translation_coze_contract_failed'
        && error.message === 'Coze 工作流执行失败'
        && !error.message.includes('PRIVATE_SCRIPT_INPUT'),
    );
  } finally {
    global.fetch = originalFetch;
  }
});
