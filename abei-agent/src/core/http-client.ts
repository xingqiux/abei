import { FireflyHttpError, FireflyNetworkError, FireflyTimeoutError } from './errors.js';

export type QueryValue = string | number | boolean | Array<string | number | boolean> | undefined;

export interface FireflyHttpClientOptions {
  baseUrl: string;
  token?: string;
  timeout?: number;
  traceId?: string;
  fetchImpl?: typeof fetch;
}

export interface FireflyRequestOptions {
  query?: Record<string, QueryValue>;
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
}

export class FireflyHttpClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeout: number;

  constructor(private readonly options: FireflyHttpClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeout = options.timeout ?? 30000;
  }

  async request<T = unknown>(
    method: string,
    path: string,
    options: FireflyRequestOptions = {},
  ): Promise<T> {
    const { response, url } = await this.fetchResponse(method, path, options);
    const rawBody = await response.text();
    const parsedBody = parseResponseBody(rawBody, response.headers.get('content-type'));

    if (!response.ok) {
      throw new FireflyHttpError({
        status: response.status,
        method: method.toUpperCase(),
        url,
        body: parsedBody,
        rawBody,
      });
    }

    return parsedBody as T;
  }

  private async fetchResponse(
    method: string,
    path: string,
    options: FireflyRequestOptions,
  ): Promise<{ response: Response; url: string }> {
    const url = buildUrl(this.options.baseUrl, path, options.query);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...options.headers,
    };

    if (this.options.token) {
      headers.Authorization = `Bearer ${this.options.token}`;
    }
    if (this.options.traceId) {
      headers['X-Trace-Id'] = this.options.traceId;
    }

    let body = options.body;
    if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.json);
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeout);

    try {
      const response = await this.fetchImpl(url, {
        method: method.toUpperCase(),
        headers,
        body,
        signal: controller.signal,
      });

      return { response, url };
    } catch (error) {
      if (timedOut) {
        throw new FireflyTimeoutError(url, this.timeout, error);
      }
      throw new FireflyNetworkError(
        `Could not reach Firefly III at ${url}. Check the configured base URL and whether the server is running.`,
        error,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

export function buildUrl(
  baseUrl: string,
  path: string,
  query: Record<string, QueryValue> = {},
): string {
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`${normalizedBase}${normalizedPath}`);

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(key, String(item));
      }
      continue;
    }
    url.searchParams.set(key, String(value));
  }

  return url.toString();
}

function parseResponseBody(rawBody: string, contentType: string | null): unknown {
  if (rawBody === '') {
    return undefined;
  }
  if (isJsonContentType(contentType)) {
    try {
      return JSON.parse(rawBody);
    } catch {
      return rawBody;
    }
  }
  return rawBody;
}

function isJsonContentType(contentType: string | null): boolean {
  if (!contentType) {
    return false;
  }
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === 'application/json' || mediaType.endsWith('+json');
}
