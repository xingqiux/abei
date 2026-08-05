/**
 * 运行时令牌方案（见 docs/design/granary-web-plan.md §3）：
 * 生产环境不把 PAT 烤进构建产物，改为启动后由用户在 TokenGate 里粘贴，存 sessionStorage。
 * 旧版 localStorage 值只在首次读取时迁移；开发期可用 VITE_FIREFLY_TOKEN 兜底。
 */
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

export class FireflyApiError extends Error {
  status: number
  validationErrors?: Record<string, string[]>

  constructor(status: number, message: string, validationErrors?: Record<string, string[]>) {
    super(message)
    this.status = status
    this.validationErrors = validationErrors
    this.name = 'FireflyApiError'
  }
}

export class FireflySessionChangedError extends Error {
  constructor() {
    super('认证身份已变更，已丢弃旧请求结果')
    this.name = 'FireflySessionChangedError'
  }
}

/** 401：令牌缺失或已失效。抛出后 TokenGate 通过 UNAUTHORIZED_EVENT 监听并弹出令牌页。 */
export class FireflyAuthError extends FireflyApiError {
  constructor(message = '未授权：令牌缺失或已失效') {
    super(401, message)
    this.name = 'FireflyAuthError'
  }
}

/**
 * Firefly III 校验失败（422）返回 Laravel 默认结构 {message, errors: {field: string[]}}；
 * 尽量拼出人类可读的错误信息，解析失败则回退到原始文本（截断）。
 */
function parseErrorBody(
  status: number,
  statusText: string,
  raw: string,
): { message: string; validationErrors?: Record<string, string[]> } {
  try {
    const parsed = JSON.parse(raw) as { message?: string; errors?: Record<string, string[]> }
    if (parsed.errors && Object.keys(parsed.errors).length > 0) {
      return {
        message: Object.values(parsed.errors).flat().join('；'),
        validationErrors: parsed.errors,
      }
    }
    if (parsed.message) return { message: parsed.message }
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
    throw new FireflyAuthError(parsed.message)
  }
  throw new FireflyApiError(res.status, parsed.message, parsed.validationErrors)
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
    throw new FireflySessionChangedError()
  }
}

/**
 * 调用本地 Firefly III API（开发期经 Vite proxy 转发 /api → 127.0.0.1:18001；
 * 生产由同域 nginx 反代 /api → app，见 granary-web/nginx.conf）。
 */
export async function fireflyFetch<T = unknown>(
  path: string,
  params?: Record<string, string | number | readonly (string | number)[] | undefined>,
): Promise<T> {
  const identity = requestIdentity()
  const url = new URL(path, window.location.origin)
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue
      // 数组参数：Firefly chart 等用 accounts[]=id 形式（见 ChartRequest accounts.*）
      if (Array.isArray(value)) {
        for (const item of value) {
          url.searchParams.append(`${key}[]`, String(item))
        }
        continue
      }
      url.searchParams.set(key, String(value))
    }
  }

  const res = await fetch(url.toString(), {
    signal: identity.signal,
    headers: {
      Authorization: `Bearer ${identity.token}`,
      Accept: 'application/json',
    },
  })

  assertRequestIdentity(identity)
  if (!res.ok) return throwForResponse(res, identity)
  if (res.status === 204) return undefined as T
  const data = await res.json() as T
  assertRequestIdentity(identity)
  return data
}

/**
 * POST 到本地 Firefly III API（开发期经 Vite proxy 转发 /api → 127.0.0.1:18001）。
 */
export async function fireflyPost<T = unknown>(path: string, body: unknown): Promise<T> {
  const identity = requestIdentity()
  const url = new URL(path, window.location.origin)

  const res = await fetch(url.toString(), {
    method: 'POST',
    signal: identity.signal,
    headers: {
      Authorization: `Bearer ${identity.token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  assertRequestIdentity(identity)
  if (!res.ok) return throwForResponse(res, identity)
  if (res.status === 204) return undefined as T
  const data = await res.json() as T
  assertRequestIdentity(identity)
  return data
}

/** PUT：交易编辑等写操作。 */
export async function fireflyPut<T = unknown>(path: string, body: unknown): Promise<T> {
  const identity = requestIdentity()
  const url = new URL(path, window.location.origin)

  const res = await fetch(url.toString(), {
    method: 'PUT',
    signal: identity.signal,
    headers: {
      Authorization: `Bearer ${identity.token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  assertRequestIdentity(identity)
  if (!res.ok) return throwForResponse(res, identity)
  const data = await res.json() as T
  assertRequestIdentity(identity)
  return data
}

/** PATCH：账单行局部更新等（Firefly 自建 bill-statement-rows）。 */
export async function fireflyPatch<T = unknown>(path: string, body: unknown): Promise<T> {
  const identity = requestIdentity()
  const url = new URL(path, window.location.origin)

  const res = await fetch(url.toString(), {
    method: 'PATCH',
    signal: identity.signal,
    headers: {
      Authorization: `Bearer ${identity.token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  assertRequestIdentity(identity)
  if (!res.ok) return throwForResponse(res, identity)
  const data = await res.json() as T
  assertRequestIdentity(identity)
  return data
}

/**
 * DELETE：实测 DELETE /api/v1/transactions/{groupId} 返回 204 空体。
 */
export async function fireflyDelete(path: string): Promise<void> {
  const identity = requestIdentity()
  const url = new URL(path, window.location.origin)

  const res = await fetch(url.toString(), {
    method: 'DELETE',
    signal: identity.signal,
    headers: {
      Authorization: `Bearer ${identity.token}`,
      Accept: 'application/json',
    },
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

export async function fireflyDownload(
  path: string,
): Promise<{ blob: Blob; filename: string | null }> {
  const identity = requestIdentity()
  const res = await fetch(new URL(path, window.location.origin), {
    signal: identity.signal,
    headers: {
      Authorization: `Bearer ${identity.token}`,
      Accept: '*/*',
    },
  })
  assertRequestIdentity(identity)
  if (!res.ok) return throwForResponse(res, identity)
  const blob = await res.blob()
  assertRequestIdentity(identity)
  return { blob, filename: downloadFilename(res) }
}

export async function fireflyUpload(path: string, body: Blob): Promise<void> {
  const identity = requestIdentity()
  const res = await fetch(new URL(path, window.location.origin), {
    method: 'POST',
    signal: identity.signal,
    headers: {
      Authorization: `Bearer ${identity.token}`,
      Accept: 'application/json',
      'Content-Type': body.type || 'application/octet-stream',
    },
    body,
  })
  assertRequestIdentity(identity)
  if (!res.ok) return throwForResponse(res, identity)
}
