import { describe, expect, test } from 'vitest';

import { decryptModelConfig, encryptModelConfig } from '../../src/agent/store.js';

describe('AI model config encryption', () => {
  test('round-trips without storing the API key in plaintext', () => {
    const config = {
      provider: 'openai' as const,
      model: 'gpt-5.6-terra',
      apiToken: 'sk-private-value',
      apiUrl: 'https://models.example/v1',
    };

    const encrypted = encryptModelConfig(config, 'application-secret');

    expect(encrypted).not.toContain(config.apiToken);
    expect(decryptModelConfig(encrypted, 'application-secret')).toEqual(config);
    expect(() => decryptModelConfig(encrypted, 'different-secret')).toThrow();
  });
});
