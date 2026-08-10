import { describe, expect, test } from 'vitest';

import { createModelRuntime } from '../../src/agent/model-runtime.js';
import { modelFailureMessage } from '../../src/agent/chat.js';

describe('agent model runtime', () => {
  test('uses an OpenAI-compatible base URL for every catalog model', () => {
    const runtime = createModelRuntime({
      AI_PROVIDER: 'openai',
      AI_MODEL: 'gpt-5.4-mini',
      OPENAI_BASE_URL: 'https://gateway.example/v1/',
    });

    expect(runtime.model?.baseUrl).toBe('https://gateway.example/v1');
    expect(
      runtime.models.getModels('openai').every((model) => model.baseUrl === runtime.model?.baseUrl),
    ).toBe(true);
  });

  test('uses a saved credential and custom model without restarting', async () => {
    const runtime = createModelRuntime(
      {},
      {
        provider: 'openai',
        model: 'company-model',
        apiToken: 'saved-secret',
        apiUrl: 'https://models.example/v1/',
      },
    );

    expect(runtime.model?.id).toBe('company-model');
    expect(runtime.model?.baseUrl).toBe('https://models.example/v1');
    expect(await runtime.models.checkAuth('openai')).toMatchObject({ type: 'api_key' });
  });

  test('never exposes provider errors or credential fragments', () => {
    const message = modelFailureMessage('Incorrect API key: sk-secret');

    expect(message).toBe('模型请求失败，请检查模型凭证和服务地址。');
    expect(message).not.toContain('sk-secret');
  });
});
