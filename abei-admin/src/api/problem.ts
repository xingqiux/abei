/**
 * abei-api 的错误形状：RFC 9457 `application/problem+json`。
 *
 * 服务端保证每个错误都带一个机读的 `reason`（驼峰码）和中文的 `title`/`detail`。
 * `reason` 是分支依据，`title`/`detail` 是给人看的正文——两者分工不要混：
 * 按文案做判断会在服务端改一个字的时候悄悄失效。
 */

/** 服务端会发的机读错误码。列表跟 abei-api 的 `problem.rs` 对齐。 */
export const ABEI_REASONS = [
  'MissingToken',
  'InvalidToken',
  'InvalidParams',
  'InvalidDate',
  'NotFound',
  'ConfirmationRequired',
  'UpstreamUnavailable',
  'UpstreamError',
  'Internal',
] as const

export type AbeiReason = (typeof ABEI_REASONS)[number]

/** 未来服务端加了新码时不要当成「没有 reason」，原样留着。 */
export type AbeiReasonCode = AbeiReason | (string & {})

export interface ProblemBody {
  type?: string
  title?: string
  status?: number
  reason?: string
  detail?: string
  resource?: string
  verb?: string
  upstream?: unknown
}

/** 逃生舱下游是 Firefly，它的 422 仍是 Laravel 的 `{message, errors}`。 */
export interface LaravelValidationBody {
  message?: string
  errors?: Record<string, string[]>
}

export function isProblemBody(value: unknown): value is ProblemBody {
  if (typeof value !== 'object' || value === null) return false
  const body = value as ProblemBody
  return typeof body.reason === 'string' && typeof body.title === 'string'
}

/**
 * 该怎么把一个错误讲给用户听。
 *
 * `tone` 决定页面的姿态，不决定文字：
 * - `auth`：令牌没了或过期，要引导重新配对，不是「出错了」。
 * - `offline`：阿贝连不上 Firefly，是「连不上」，重试有意义，别让人以为自己填错了。
 * - `confirm`：服务端要一次显式确认，属于流程的一步，不是失败。
 * - `input`：人填的东西有问题，指回表单。
 * - `missing`：东西不在了，通常该刷新列表。
 * - `failure`：剩下的真失败。
 */
export type ErrorTone = 'auth' | 'offline' | 'confirm' | 'input' | 'missing' | 'failure'

export function toneForReason(reason: AbeiReasonCode | undefined, status: number): ErrorTone {
  switch (reason) {
    case 'MissingToken':
    case 'InvalidToken':
      return 'auth'
    case 'UpstreamUnavailable':
      return 'offline'
    case 'ConfirmationRequired':
      return 'confirm'
    case 'InvalidParams':
    case 'InvalidDate':
      return 'input'
    case 'NotFound':
      return 'missing'
    case 'UpstreamError':
    case 'Internal':
      return 'failure'
    default:
      break
  }
  // 没有 reason 的响应（逃传舱下游直出、或者代理层自己的错）按状态码退一步判断。
  if (status === 401) return 'auth'
  if (status === 404) return 'missing'
  if (status === 409) return 'confirm'
  if (status === 422 || status === 400) return 'input'
  if (status === 502 || status === 503 || status === 504) return 'offline'
  return 'failure'
}
