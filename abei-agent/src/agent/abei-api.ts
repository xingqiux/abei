/**
 * abei-api 客户端：取能力目录、按目录调用能力。
 *
 * 能力目录是唯一真源，agent 这边不留第二份能力表——工具定义、闸门档位、
 * 路由方法都从 `GET /v1/catalog` 现取。写闸门在 abei-api 服务端执行，
 * 这里只负责把 dry_run / confirm 两个查询参数如实带过去。
 */

/** 风险档。read 直接执行；draft 只写草稿；confirm 必须人工确认后才落库。 */
export type CapabilityRisk = 'read' | 'draft' | 'confirm';

export interface AbeiCapability {
  id: string;
  resource: string;
  verb: string;
  risk: CapabilityRisk;
  backend: string;
  label: string;
  description: string;
  method: string;
  path: string;
  tool_name: string;
  command: string[];
  /** 只能由人在受信界面现填的参数名（密码、验证码这类）。目录标的，agent 不另存。 */
  human_only: string[];
  /** 每条示例都有等价的命令行写法和参数对象，abei-api 那边有测试保证它们跑得通。 */
  examples: Array<{ title: string; command: string; params: Record<string, unknown> }>;
  params: Record<string, unknown>;
}

export interface AbeiGate {
  dryRun?: boolean;
  confirm?: boolean;
}

/** 目录快照。按 id 和工具名两种方式查同一批能力。 */
export class Catalog {
  private readonly byIdIndex: Map<string, AbeiCapability>;
  private readonly byToolIndex: Map<string, AbeiCapability>;

  constructor(
    readonly version: string,
    private readonly capabilities: AbeiCapability[],
  ) {
    this.byIdIndex = new Map(capabilities.map((capability) => [capability.id, capability]));
    this.byToolIndex = new Map(
      capabilities.map((capability) => [capability.tool_name, capability]),
    );
  }

  list(): readonly AbeiCapability[] {
    return this.capabilities;
  }

  byId(id: string): AbeiCapability | undefined {
    return this.byIdIndex.get(id);
  }

  byToolName(name: string): AbeiCapability | undefined {
    return this.byToolIndex.get(name);
  }
}

/** abei-api 回的 RFC 9457 错误。`reason` 是驼峰机读码，调用方按它分支。 */
export class AbeiProblemError extends Error {
  readonly status: number;
  readonly reason: string;
  readonly problem: Record<string, unknown>;

  constructor(status: number, problem: Record<string, unknown>) {
    super(problemMessage(status, problem));
    this.name = 'AbeiProblemError';
    this.status = status;
    this.reason = typeof problem.reason === 'string' ? problem.reason : 'Unknown';
    this.problem = problem;
  }

  /** 这条能力是 confirm 档、又没带闸门参数。不是错误，是「等人确认」。 */
  get needsConfirmation(): boolean {
    return this.reason === 'ConfirmationRequired';
  }
}

/** 连不上 abei-api。和「abei-api 说你参数不对」是两回事，分开报。 */
export class AbeiUnavailableError extends Error {
  constructor(url: string, cause?: unknown) {
    super(`连不上 abei-api（${url}）。`);
    this.name = 'AbeiUnavailableError';
    this.cause = cause;
  }
}

export interface AbeiApiOptions {
  baseUrl: string;
  timeout?: number;
  /** 目录缓存有效期。到期后下一次取会重新拉一遍。 */
  catalogTtlMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CATALOG_TTL_MS = 300_000;

export class AbeiApi {
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly catalogTtlMs: number;
  private readonly fetchImpl: typeof fetch;
  private cached?: { catalog: Catalog; fetchedAt: number };
  private inFlight?: Promise<Catalog>;

  constructor(options: AbeiApiOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    this.catalogTtlMs = options.catalogTtlMs ?? DEFAULT_CATALOG_TTL_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * 取目录。目录内容与用户无关，所以缓存不按令牌分；令牌只用来过 abei-api 的鉴权。
   * 并发的首次调用共用同一次请求，不会把目录拉 N 遍。
   */
  async catalog(token: string): Promise<Catalog> {
    const cached = this.cached;
    if (cached && Date.now() - cached.fetchedAt < this.catalogTtlMs) return cached.catalog;
    this.inFlight ??= this.fetchCatalog(token).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  /** 按能力调用。参数里的路径占位符先填进 URL，剩下的按方法进查询串或请求体。 */
  async invoke(args: {
    token: string;
    capability: AbeiCapability;
    params: Record<string, unknown>;
    gate?: AbeiGate;
  }): Promise<unknown> {
    const { path, rest } = fillPath(args.capability.path, args.params);
    const usesBody = args.capability.method !== 'GET' && args.capability.method !== 'DELETE';
    const query = new URLSearchParams();
    if (!usesBody) appendQuery(query, rest);
    if (args.gate?.dryRun) query.set('dry_run', 'true');
    if (args.gate?.confirm) query.set('confirm', 'true');

    const search = query.toString();
    return this.send(args.capability.method, search ? `${path}?${search}` : path, {
      token: args.token,
      json: usesBody ? rest : undefined,
    });
  }

  private async fetchCatalog(token: string): Promise<Catalog> {
    const body = await this.send('GET', '/v1/catalog', { token });
    const view = body as { version?: unknown; capabilities?: unknown };
    if (!Array.isArray(view.capabilities)) {
      throw new AbeiUnavailableError(`${this.baseUrl}/v1/catalog`);
    }
    const catalog = new Catalog(
      typeof view.version === 'string' ? view.version : 'unknown',
      view.capabilities as AbeiCapability[],
    );
    this.cached = { catalog, fetchedAt: Date.now() };
    return catalog;
  }

  private async send(
    method: string,
    pathAndQuery: string,
    options: { token: string; json?: unknown },
  ): Promise<unknown> {
    const url = `${this.baseUrl}${pathAndQuery}`;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${options.token}`,
    };
    if (options.json !== undefined) headers['Content-Type'] = 'application/json';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: options.json === undefined ? undefined : JSON.stringify(options.json),
        signal: controller.signal,
      });
    } catch (error) {
      throw new AbeiUnavailableError(url, error);
    } finally {
      clearTimeout(timer);
    }

    const raw = await response.text();
    const parsed = raw === '' ? undefined : safeJson(raw);
    if (!response.ok) {
      throw new AbeiProblemError(
        response.status,
        isRecord(parsed) ? parsed : { detail: '上游没有返回可解析的错误体。' },
      );
    }
    return parsed;
  }
}

/**
 * 把 `/v1/bills/{id}/import` 里的占位符填成实际值，并把填进路径的键从参数里摘掉。
 * abei-api 以路径为准，请求体里再带一份只是噪声。
 */
export function fillPath(
  template: string,
  params: Record<string, unknown>,
): { path: string; rest: Record<string, unknown> } {
  const rest = { ...params };
  const path = template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = rest[key];
    if (value === undefined || value === null || value === '') {
      throw new AbeiProblemError(400, {
        reason: 'InvalidParams',
        title: '参数不完整',
        detail: `缺少路径参数 ${key}。`,
      });
    }
    delete rest[key];
    return encodeURIComponent(String(value));
  });
  return { path, rest };
}

function appendQuery(query: URLSearchParams, params: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) query.append(key, String(item));
      continue;
    }
    query.set(key, String(value));
  }
}

function problemMessage(status: number, problem: Record<string, unknown>): string {
  const title = typeof problem.title === 'string' ? problem.title : `HTTP ${status}`;
  const detail = typeof problem.detail === 'string' ? problem.detail : undefined;
  return detail ? `${title}：${detail}` : title;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
