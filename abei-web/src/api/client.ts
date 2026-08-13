/**
 * HTTP 层。所有请求都打 abei-api（默认 18002），不再直连 Firefly。
 *
 * 地址走 `VITE_ABEI_API_URL`，默认 `/` 同源；开发期在 `.env.local` 里指向
 * `http://127.0.0.1:18002`，或者用 vite 的 proxy 把 `/v1` 转过去（见 vite.config.ts）。
 *
 * 鉴权没变：`Authorization: Bearer <Firefly 个人访问令牌>`，abei-api 原样透传给 Firefly，
 * 所以现存的令牌照用。令牌只进请求头，不进 URL，也不进日志。
 *
 * 运行时令牌方案（见 docs/design/abei-web-plan.md §3）：
 * 生产环境不把令牌烤进构建产物，改为启动后由用户在 TokenGate 里粘贴，存 sessionStorage。
 */
import {
  isProblemBody,
  toneForReason,
  type AbeiReasonCode,
  type ErrorTone,
  type LaravelValidationBody,
  type ProblemBody,
} from './problem'

// 存储键沿用 granary.* 前缀：单独为改名清空本地令牌不划算，等下次有破坏性变更时一起迁。不是漏改。
export const TOKEN_STORAGE_KEY = 'granary.token'

/** 401 时全局广播，TokenGate 监听后弹出令牌页；避免每个查询自己处理未授权。 */
export const UNAUTHORIZED_EVENT = 'granary:unauthorized'

/** 用户粘贴并保存令牌后广播；DateRangePreferenceSync 等需重新启用依赖令牌的查询。 */
export const TOKEN_READY_EVENT = 'granary:token-ready'

let tokenGeneration = 0
let sessionAbortController = new AbortController()

function rotateSession(): void {
  tokenGeneration += 1
  sessionAbortController.abort()
  sessionAbortController = new AbortController()
}

export function getStoredToken(): string | null {
  try {
    const sessionToken = sessionStorage.getItem(TOKEN_STORAGE_KEY)
    if (sessionToken) return sessionToken
    const legacyToken = localStorage.getItem(TOKEN_STORAGE_KEY)
    if (legacyToken) {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, legacyToken)
      localStorage.removeItem(TOKEN_STORAGE_KEY)
    }
    return legacyToken
  } catch {
    return null
  }
}

export function setStoredToken(token: string): void {
  sessionStorage.setItem(TOKEN_STORAGE_KEY, token.trim())
  localStorage.removeItem(TOKEN_STORAGE_KEY)
  rotateSession()
}

export function clearStoredToken(): void {
  sessionStorage.removeItem(TOKEN_STORAGE_KEY)
  localStorage.removeItem(TOKEN_STORAGE_KEY)
  rotateSession()
}

/** 当前生效 token：浏览器会话存储优先，其次开发期 .env.local 兜底。 */
export function getActiveToken(): string {
  return getStoredToken() || import.meta.env.VITE_FIREFLY_TOKEN || ''
}

export function hasActiveToken(): boolean {
  return getActiveToken().length > 0
}

function notifyUnauthorized(): void {
  window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT))
}

/**
 * abei-api 的地址。默认同源，生产由 nginx 反代过去。
 *
 * 结尾补 `/`：`new URL('v1/bills', 'http://host/abei')` 会把 `abei` 当文件名丢掉，
 * 补成 `http://host/abei/` 才会拼成子路径。
 */
function apiBase(): string {
  const configured = import.meta.env.VITE_ABEI_API_URL?.trim()
  const base = configured && configured.length > 0 ? configured : '/'
  return base.endsWith('/') ? base : `${base}/`
}

function apiUrl(path: string): URL {
  const base = new URL(apiBase(), window.location.origin)
  return new URL(path.replace(/^\/+/, ''), base)
}

/**
 * 逃生舱：还没建模成资源的接口，路径原样加前缀转给 Firefly。
 *
 * `viaFirefly('/api/v1/budgets')` → `/v1/firefly/api/v1/budgets`。
 * 建模一个域之后，把调用改成打 `/v1/<资源>`，这里就少一条。
 */
export function viaFirefly(path: string): string {
  return `/v1/firefly/${path.replace(/^\/+/, '')}`
}

/* ------------------------------------------------------------------ *
 * 错误
 * ------------------------------------------------------------------ */

/**
 * abei-api 的错误。`reason` 是机读码，上层按它分支（见 problem.ts 的 toneForReason）。
 *
 * `message` 取服务端的 `detail`，退而取 `title`——两者都是中文人话，可以直接显示。
 */
export class AbeiApiError extends Error {
  readonly status: number
  readonly reason?: AbeiReasonCode
  readonly title?: string
  readonly detail?: string
  /** 出错的资源与动词，服务端给的，用于把错误指回具体功能。 */
  readonly resource?: string
  readonly verb?: string
  /** Firefly 原样回传的错误体，排障用。 */
  readonly upstream?: unknown
  /** 逃生舱下游 Firefly 的 422 字段级错误，仍是 Laravel 的形状。 */
  readonly validationErrors?: Record<string, string[]>

  constructor(
    status: number,
    message: string,
    extra: {
      reason?: AbeiReasonCode
      title?: string
      detail?: string
      resource?: string
      verb?: string
      upstream?: unknown
      validationErrors?: Record<string, string[]>
    } = {},
  ) {
    super(message)
    this.name = 'AbeiApiError'
    this.status = status
    this.reason = extra.reason
    this.title = extra.title
    this.detail = extra.detail
    this.resource = extra.resource
    this.verb = extra.verb
    this.upstream = extra.upstream
    this.validationErrors = extra.validationErrors
  }

  /** 页面该用什么姿态呈现这个错误。 */
  get tone(): ErrorTone {
    return toneForReason(this.reason, this.status)
  }
}

export class AbeiSessionChangedError extends Error {
  constructor() {
    super('认证身份已变更，已丢弃旧请求结果')
    this.name = 'AbeiSessionChangedError'
  }
}

/**
 * 令牌缺失或已失效（reason `MissingToken` / `InvalidToken`）。
 * 抛出后 TokenGate 通过 UNAUTHORIZED_EVENT 监听并弹出令牌页，引导重新配对。
 */
export class AbeiAuthError extends AbeiApiError {
  constructor(message = '未授权：令牌缺失或已失效', extra: { reason?: AbeiReasonCode; detail?: string } = {}) {
    super(401, message, { ...extra, reason: extra.reason ?? 'InvalidToken' })
    this.name = 'AbeiAuthError'
  }
}

/**
 * confirm 档的写能力没带 `confirm=true` 也没带 `dry_run=true`（reason `ConfirmationRequired`）。
 * 这不是失败，是流程要求先给人看一眼预览。
 */
export function isConfirmationRequired(error: unknown): boolean {
  return error instanceof AbeiApiError && error.reason === 'ConfirmationRequired'
}

/** 阿贝在，但它连不上 Firefly。重试有意义，别写成「出错了」。 */
export function isUpstreamUnavailable(error: unknown): boolean {
  return error instanceof AbeiApiError && error.reason === 'UpstreamUnavailable'
}

export function errorTone(error: unknown): ErrorTone {
  if (error instanceof AbeiApiError) return error.tone
  return 'failure'
}

/**
 * 解析错误体。两种形状：
 * - abei-api 自己的 RFC 9457 problem+json，带机读 reason；
 * - 逃生舱把 Firefly 的响应原样回传时，可能是 Laravel 的 `{message, errors}`。
 */
function parseErrorBody(
  status: number,
  statusText: string,
  raw: string,
): {
  message: string
  reason?: AbeiReasonCode
  title?: string
  detail?: string
  resource?: string
  verb?: string
  upstream?: unknown
  validationErrors?: Record<string, string[]>
} {
  try {
    const parsed: unknown = JSON.parse(raw)

    if (isProblemBody(parsed)) {
      const problem = parsed as ProblemBody
      return {
        message: problem.detail || problem.title || `${status} ${statusText}`,
        reason: problem.reason,
        title: problem.title,
        detail: problem.detail,
        resource: problem.resource,
        verb: problem.verb,
        upstream: problem.upstream,
      }
    }

    const laravel = parsed as LaravelValidationBody
    if (laravel?.errors && Object.keys(laravel.errors).length > 0) {
      return {
        message: Object.values(laravel.errors).flat().join('；'),
        validationErrors: laravel.errors,
      }
    }
    if (laravel?.message) return { message: laravel.message }
  } catch {
    // 不是 JSON，走下面的兜底
  }
  return { message: `${status} ${statusText}: ${raw.slice(0, 300)}` }
}

async function throwForResponse(
  res: Response,
  identity: { generation: number; token: string },
): Promise<never> {
  assertRequestIdentity(identity)
  const body = await res.text().catch(() => '')
  assertRequestIdentity(identity)
  const parsed = parseErrorBody(res.status, res.statusText, body)

  if (res.status === 401) {
    notifyUnauthorized()
    throw new AbeiAuthError(parsed.message, { reason: parsed.reason, detail: parsed.detail })
  }
  throw new AbeiApiError(res.status, parsed.message, parsed)
}

function requestIdentity(): { generation: number; token: string; signal: AbortSignal } {
  return {
    generation: tokenGeneration,
    token: getActiveToken(),
    signal: sessionAbortController.signal,
  }
}

function assertRequestIdentity(identity: { generation: number; token: string }): void {
  if (identity.generation !== tokenGeneration || identity.token !== getActiveToken()) {
    throw new AbeiSessionChangedError()
  }
}

/* ------------------------------------------------------------------ *
 * 传输
 * ------------------------------------------------------------------ */

export type QueryParams = Record<
  string,
  string | number | boolean | readonly (string | number)[] | undefined
>

function applyParams(url: URL, params?: QueryParams): void {
  if (!params) return
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    // 数组参数：Firefly chart 等用 accounts[]=id 形式（见 ChartRequest accounts.*）
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(`${key}[]`, String(item))
      continue
    }
    url.searchParams.set(key, String(value))
  }
}

function authHeaders(token: string, extra?: HeadersInit): Headers {
  const headers = new Headers(extra)
  headers.set('Authorization', `Bearer ${token}`)
  if (!headers.has('Accept')) headers.set('Accept', 'application/json')
  return headers
}

export async function apiGet<T = unknown>(path: string, params?: QueryParams): Promise<T> {
  const identity = requestIdentity()
  const url = apiUrl(path)
  applyParams(url, params)

  const res = await fetch(url.toString(), {
    signal: identity.signal,
    headers: authHeaders(identity.token),
  })

  assertRequestIdentity(identity)
  if (!res.ok) return throwForResponse(res, identity)
  if (res.status === 204) return undefined as T
  const data = (await res.json()) as T
  assertRequestIdentity(identity)
  return data
}

async function sendJson<T>(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown,
  params?: QueryParams,
): Promise<T> {
  const identity = requestIdentity()
  const url = apiUrl(path)
  applyParams(url, params)

  const res = await fetch(url.toString(), {
    method,
    signal: identity.signal,
    headers: authHeaders(identity.token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  })

  assertRequestIdentity(identity)
  if (!res.ok) return throwForResponse(res, identity)
  if (res.status === 204) return undefined as T
  const data = (await res.json()) as T
  assertRequestIdentity(identity)
  return data
}

/**
 * 写请求。参数走请求体，写闸门（`dry_run` / `confirm`）走查询串——服务端就是这么分的。
 * 闸门用 `params` 传，别塞进 body。
 */
export function apiPost<T = unknown>(path: string, body: unknown, params?: QueryParams): Promise<T> {
  return sendJson<T>('POST', path, body, params)
}

export function apiPut<T = unknown>(path: string, body: unknown, params?: QueryParams): Promise<T> {
  return sendJson<T>('PUT', path, body, params)
}

export function apiPatch<T = unknown>(path: string, body: unknown, params?: QueryParams): Promise<T> {
  return sendJson<T>('PATCH', path, body, params)
}

export function apiDeleteJson<T = unknown>(path: string, body: unknown, params?: QueryParams): Promise<T> {
  return sendJson<T>('DELETE', path, body, params)
}

export async function apiPostForm<T = unknown>(path: string, body: FormData): Promise<T> {
  const identity = requestIdentity()
  const res = await fetch(apiUrl(path).toString(), {
    method: 'POST',
    signal: identity.signal,
    headers: authHeaders(identity.token),
    body,
  })

  assertRequestIdentity(identity)
  if (!res.ok) return throwForResponse(res, identity)
  const data = (await res.json()) as T
  assertRequestIdentity(identity)
  return data
}

export async function apiDelete(path: string): Promise<void> {
  const identity = requestIdentity()
  const res = await fetch(apiUrl(path).toString(), {
    method: 'DELETE',
    signal: identity.signal,
    headers: authHeaders(identity.token),
  })

  assertRequestIdentity(identity)
  if (!res.ok) return throwForResponse(res, identity)
}

function downloadFilename(res: Response): string | null {
  const disposition = res.headers.get('Content-Disposition') ?? ''
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1]
  if (encoded) {
    try {
      return decodeURIComponent(encoded)
    } catch {
      return encoded
    }
  }
  return /filename=(?:"([^"]+)"|([^;]+))/i.exec(disposition)?.slice(1).find(Boolean)?.trim() ?? null
}

/** 附件下载。逃生舱是流式回传的，附件照样能过。 */
export async function apiDownload(path: string): Promise<{ blob: Blob; filename: string | null }> {
  const identity = requestIdentity()
  const res = await fetch(apiUrl(path).toString(), {
    signal: identity.signal,
    headers: authHeaders(identity.token, { Accept: '*/*' }),
  })
  assertRequestIdentity(identity)
  if (!res.ok) return throwForResponse(res, identity)
  const blob = await res.blob()
  assertRequestIdentity(identity)
  return { blob, filename: downloadFilename(res) }
}

export async function apiUpload(path: string, body: Blob): Promise<void> {
  const identity = requestIdentity()
  const res = await fetch(apiUrl(path).toString(), {
    method: 'POST',
    signal: identity.signal,
    headers: authHeaders(identity.token, {
      'Content-Type': body.type || 'application/octet-stream',
    }),
    body,
  })
  assertRequestIdentity(identity)
  if (!res.ok) return throwForResponse(res, identity)
}
