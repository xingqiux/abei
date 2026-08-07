import { afterEach, describe, expect, test, vi } from 'vitest';

import { discoverModels, ModelDiscoveryError } from '../../src/agent/model-discovery.js';

afterEach(() => vi.restoreAllMocks());

describe('agent model discovery', () => {
  test('reads and sorts models from an OpenAI-compatible endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'model-10' }, { id: 'model-2' }] }), {
        status: 200,
      }),
    );

    await expect(
      discoverModels({
        provider: 'openai',
        apiToken: 'sk-secret',
        apiUrl: 'https://models.example/v1/',
      }),
    ).resolves.toEqual(['model-2', 'model-10']);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://models.example/v1/models'),
      expect.objectContaining({
        headers: { Authorization: 'Bearer sk-secret' },
      }),
    );
  });

  test('normalizes Google model names', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          models: [{ name: 'models/gemini-2.5-flash' }, { name: 'models/gemini-2.5-pro' }],
        }),
        { status: 200 },
      ),
    );

    await expect(
      discoverModels({ provider: 'google', apiToken: 'google-secret' }),
    ).resolves.toEqual(['gemini-2.5-flash', 'gemini-2.5-pro']);
  });

  test('does not expose an upstream error body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('credential sk-secret rejected', { status: 401 }),
    );

    const request = discoverModels({ provider: 'openai', apiToken: 'sk-secret' });
    await expect(request).rejects.toEqual(new ModelDiscoveryError('上游拒绝了模型凭证。'));
    await expect(request).rejects.not.toHaveProperty(
      'message',
      expect.stringContaining('sk-secret'),
    );
  });
});
