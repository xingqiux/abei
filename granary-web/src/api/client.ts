const TOKEN = import.meta.env.VITE_FIREFLY_TOKEN

export class FireflyApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'FireflyApiError'
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

/**
 * 调用本地 Firefly III API（开发期经 Vite proxy 转发 /api → 127.0.0.1:8001）。
 */
export async function fireflyFetch<T = unknown>(
  path: string,
  params?: Record<string, string | number | undefined>,
): Promise<T> {
  const url = new URL(path, window.location.origin)
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
  }

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/json',
    },
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new FireflyApiError(res.status, formatErrorBody(res.status, res.statusText, body))
  }

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
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const responseBody = await res.text().catch(() => '')
    throw new FireflyApiError(res.status, formatErrorBody(res.status, res.statusText, responseBody))
  }

  return res.json() as Promise<T>
}
