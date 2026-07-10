/**
 * 运行时令牌方案（见 docs/design/granary-web-plan.md §3）：
 * 生产环境不把 PAT 烤进构建产物，改为启动后由用户在 TokenGate 里粘贴，存 localStorage。
 * 读取顺序：localStorage('granary.token') → import.meta.env.VITE_FIREFLY_TOKEN（仅开发期兜底）。
 */
export const TOKEN_STORAGE_KEY = 'granary.token'

/** 401 时全局广播，TokenGate 监听后弹出令牌页；避免每个查询自己处理未授权。 */
export const UNAUTHORIZED_EVENT = 'granary:unauthorized'

/** 用户粘贴并保存令牌后广播；DateRangePreferenceSync 等需重新启用依赖令牌的查询。 */
export const TOKEN_READY_EVENT = 'granary:token-ready'

export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY)
  } catch {
    return null
  }
}

export function setStoredToken(token: string): void {
  localStorage.setItem(TOKEN_STORAGE_KEY, token.trim())
}

export function clearStoredToken(): void {
  localStorage.removeItem(TOKEN_STORAGE_KEY)
}

/** 当前生效 token：localStorage 优先，其次开发期 .env.local 兜底。 */
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
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'FireflyApiError'
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
function formatErrorBody(status: number, statusText: string, raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { message?: string; errors?: Record<string, string[]> }
    if (parsed.errors && Object.keys(parsed.errors).length > 0) {
      return Object.values(parsed.errors).flat().join('；')
    }
    if (parsed.message) return parsed.message
  } catch {
    // 不是 JSON，走下面的兜底
  }
  return `${status} ${statusText}: ${raw.slice(0, 300)}`
}

async function throwForResponse(res: Response): Promise<never> {
  const body = await res.text().catch(() => '')
  if (res.status === 401) {
    notifyUnauthorized()
    throw new FireflyAuthError(formatErrorBody(res.status, res.statusText, body))
  }
  throw new FireflyApiError(res.status, formatErrorBody(res.status, res.statusText, body))
}

/**
 * 调用本地 Firefly III API（开发期经 Vite proxy 转发 /api → 127.0.0.1:8001；
 * 生产由同域 nginx 反代 /api → app，见 granary-web/nginx.conf）。
 */
export async function fireflyFetch<T = unknown>(
  path: string,
  params?: Record<string, string | number | readonly (string | number)[] | undefined>,
): Promise<T> {
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
    headers: {
      Authorization: `Bearer ${getActiveToken()}`,
      Accept: 'application/json',
    },
  })

  if (!res.ok) return throwForResponse(res)

  return res.json() as Promise<T>
}

/**
 * POST 到本地 Firefly III API（开发期经 Vite proxy 转发 /api → 127.0.0.1:8001）。
 */
export async function fireflyPost<T = unknown>(path: string, body: unknown): Promise<T> {
  const url = new URL(path, window.location.origin)

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getActiveToken()}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) return throwForResponse(res)

  return res.json() as Promise<T>
}

/** PUT：交易编辑等写操作。 */
export async function fireflyPut<T = unknown>(path: string, body: unknown): Promise<T> {
  const url = new URL(path, window.location.origin)

  const res = await fetch(url.toString(), {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${getActiveToken()}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) return throwForResponse(res)

  return res.json() as Promise<T>
}

/** PATCH：账单行局部更新等（Firefly 自建 bill-statement-rows）。 */
export async function fireflyPatch<T = unknown>(path: string, body: unknown): Promise<T> {
  const url = new URL(path, window.location.origin)

  const res = await fetch(url.toString(), {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${getActiveToken()}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) return throwForResponse(res)

  return res.json() as Promise<T>
}

/**
 * DELETE：实测 DELETE /api/v1/transactions/{groupId} 返回 204 空体。
 */
export async function fireflyDelete(path: string): Promise<void> {
  const url = new URL(path, window.location.origin)

  const res = await fetch(url.toString(), {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${getActiveToken()}`,
      Accept: 'application/json',
    },
  })

  if (!res.ok) return throwForResponse(res)
}
