export interface FireflyHttpErrorInput {
  status: number;
  method: string;
  url: string;
  body: unknown;
  rawBody: string;
}

export class FireflyHttpError extends Error {
  readonly status: number;
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
  readonly rawBody: string;

  constructor(input: FireflyHttpErrorInput) {
    super(formatHttpError(input));
    this.name = 'FireflyHttpError';
    this.status = input.status;
    this.method = input.method;
    this.url = input.url;
    this.body = input.body;
    this.rawBody = input.rawBody;
  }
}

export class FireflyNetworkError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'FireflyNetworkError';
  }
}

/**
 * Thrown when a request is aborted because it exceeded the configured
 * timeout, as opposed to a genuine connection failure (DNS, ECONNREFUSED,
 * etc). Distinguishing the two matters: a timeout usually means the server
 * is reachable but a request (or a backend sync task it triggered) is stuck,
 * while a connection failure means the server could not be reached at all.
 */
export class FireflyTimeoutError extends FireflyNetworkError {
  readonly url: string;
  readonly timeoutMs: number;

  constructor(url: string, timeoutMs: number, cause?: unknown) {
    super(
      `Request to ${url} timed out after ${timeoutMs}ms. The server is reachable at the base URL but the request (or a backend sync task) did not finish in time. Try increasing --timeout, or check the bill-inbox / server logs.`,
      cause,
    );
    this.name = 'FireflyTimeoutError';
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

function formatHttpError(input: FireflyHttpErrorInput): string {
  const message = extractMessage(input.body);
  if (input.status === 401) {
    return `Authentication failed: ${message}`;
  }
  if (input.status === 403) {
    return `Permission denied: ${message}`;
  }
  if (input.status === 404) {
    return `Not found: ${message}`;
  }
  if (input.status === 415) {
    return `Unsupported content type: ${message}`;
  }
  if (input.status === 422) {
    return `Validation failed: ${message}`;
  }
  if (input.status >= 500) {
    const base = `Firefly III server error (${input.status}) for ${input.method} ${input.url}: ${message}`;
    if (isStorageCacheFailure(input)) {
      return `${base}\nServer storage/cache directory is missing or not writable (storage/framework/cache). This is a server-side problem, not your import. Fix directory permissions/creation on the Firefly host, then retry.`;
    }
    return base;
  }
  return `Firefly III request failed (${input.status}) for ${input.method} ${input.url}: ${message}`;
}

/**
 * Detects Laravel's "file_put_contents(...storage/framework/cache/...): No
 * such file or directory" failure. Laravel's file cache store does not
 * recreate the nested storage/framework/cache/data directory once it is
 * wiped, so every API call (not just imports) starts failing with a 500
 * until the directory is recreated on the server. Surfacing this clearly
 * keeps operators from chasing a phantom "import" bug.
 */
function isStorageCacheFailure(input: FireflyHttpErrorInput): boolean {
  const text = `${input.rawBody} ${bodyAsText(input.body)}`;
  return text.includes('file_put_contents') && text.includes('storage/framework/cache');
}

function bodyAsText(body: unknown): string {
  if (typeof body === 'string') {
    return body;
  }
  try {
    return JSON.stringify(body ?? '');
  } catch {
    return '';
  }
}

function extractMessage(body: unknown): string {
  if (body && typeof body === 'object' && 'message' in body) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim() !== '') {
      return message;
    }
  }
  if (typeof body === 'string' && body.trim() !== '') {
    return body;
  }
  return 'No error message returned.';
}
