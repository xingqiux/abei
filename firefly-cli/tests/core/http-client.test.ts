import { describe, expect, test, vi } from 'vitest';

import {
  FireflyHttpError,
  FireflyNetworkError,
  FireflyTimeoutError,
} from '../../src/core/errors.js';
import { FireflyHttpClient } from '../../src/core/http-client.js';

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('FireflyHttpClient', () => {
  test('joins base URL and injects Firefly headers', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    const client = new FireflyHttpClient({
      baseUrl: 'http://127.0.0.1:8000/',
      token: 'secret',
      fetchImpl: fetchMock,
      traceId: '123e4567-e89b-12d3-a456-426614174000',
    });

    await client.request('GET', '/api/v1/accounts', {
      query: { page: 2, limit: 10, filter: ['name=Cash', 'active=true'] },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/api/v1/accounts?page=2&limit=10&filter=name%3DCash&filter=active%3Dtrue',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Accept: 'application/json',
          Authorization: 'Bearer secret',
          'X-Trace-Id': '123e4567-e89b-12d3-a456-426614174000',
        }),
      }),
    );
  });

  test('sends JSON content type for JSON writes', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: 1 }));
    const client = new FireflyHttpClient({
      baseUrl: 'http://localhost:8000',
      token: 'secret',
      fetchImpl: fetchMock,
    });

    await client.request('POST', '/api/v1/accounts', { json: { name: 'Cash' } });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/api/v1/accounts',
      expect.objectContaining({
        body: '{"name":"Cash"}',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  test('throws FireflyHttpError with parsed validation body', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        { message: 'The given data was invalid.', errors: { name: ['Name is required.'] } },
        { status: 422 },
      ),
    );
    const client = new FireflyHttpClient({
      baseUrl: 'http://localhost:8000',
      token: 'secret',
      fetchImpl: fetchMock,
    });

    await expect(client.request('POST', '/api/v1/accounts', { json: {} })).rejects.toMatchObject({
      status: 422,
      message: 'Validation failed: The given data was invalid.',
      body: { errors: { name: ['Name is required.'] } },
    });
  });

  test('parses JSON:API responses from Firefly III', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        { data: [{ id: '1', type: 'accounts' }] },
        { headers: { 'content-type': 'application/vnd.api+json' } },
      ),
    );
    const client = new FireflyHttpClient({
      baseUrl: 'http://localhost:8000',
      token: 'secret',
      fetchImpl: fetchMock,
    });

    await expect(client.request('GET', '/api/v1/accounts')).resolves.toEqual({
      data: [{ id: '1', type: 'accounts' }],
    });
  });

  test('throws FireflyNetworkError for fetch failures', async () => {
    const client = new FireflyHttpClient({
      baseUrl: 'http://localhost:8000',
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });

    await expect(client.request('GET', '/api/v1/about')).rejects.toBeInstanceOf(
      FireflyNetworkError,
    );
  });

  test('genuine connection failures are not classified as a timeout', async () => {
    const client = new FireflyHttpClient({
      baseUrl: 'http://localhost:8000',
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });

    const error: unknown = await client.request('GET', '/api/v1/about').catch((caught) => caught);
    expect(error).toBeInstanceOf(FireflyNetworkError);
    expect(error).not.toBeInstanceOf(FireflyTimeoutError);
    expect((error as Error).message).toContain('Could not reach Firefly III');
  });

  test('throws FireflyTimeoutError when the request timeout aborts the fetch', async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('This operation was aborted', 'AbortError'));
          });
        }),
    );
    const client = new FireflyHttpClient({
      baseUrl: 'http://localhost:8000',
      fetchImpl: fetchMock as unknown as typeof fetch,
      timeout: 10,
    });

    const error: unknown = await client
      .request('GET', '/api/v1/bill-inbox/sync')
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(FireflyTimeoutError);
    expect((error as FireflyTimeoutError).timeoutMs).toBe(10);
    expect((error as FireflyTimeoutError).message).toContain('timed out after 10ms');
    expect((error as FireflyTimeoutError).message).toContain('--timeout');
  });

  test('classifies forbidden admin failures', async () => {
    const error = new FireflyHttpError({
      status: 403,
      method: 'GET',
      url: 'http://localhost/api/v1/users',
      body: { message: 'This action is unauthorized.' },
      rawBody: '{"message":"This action is unauthorized."}',
    });

    expect(error.message).toContain('Permission denied');
  });
});
