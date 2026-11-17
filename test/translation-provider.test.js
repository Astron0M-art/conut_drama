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
} = require('../lib/translation-provider');

const originalFetch = global.fetch;

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
