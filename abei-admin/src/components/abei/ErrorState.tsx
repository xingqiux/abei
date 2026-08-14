import { CloudSlash, Key, Warning } from '@phosphor-icons/react'
import { AbeiApiError, errorTone } from '../../api/client'
import type { ErrorTone } from '../../api/problem'
import { Button } from '../ui/Button'

/**
 * 把一个错误讲成人话。
 *
 * 分支依据是 abei-api 的机读 `reason`，不是文案匹配（见 api/problem.ts）。
 * 三种情形值得跟「出错了」分开说：
 *
 * - 令牌没了或过期（`MissingToken` / `InvalidToken`）：该去重新配对，重试没用。
 *   401 时 client 已经广播过 UNAUTHORIZED_EVENT，令牌页会自己弹出来，这里只把话说对。
 * - 阿贝连不上 Firefly（`UpstreamUnavailable`）：是「连不上」，不是「出错了」，重试有意义。
 * - 服务端要一次显式确认（`ConfirmationRequired`）：那是流程的一步，不该长得像失败。
 *
 * `fallback` 是页面自己的话（「交易加载失败」这种），只在服务端没给正文时用。
 */
function describe(
  fallback: string,
  error: unknown,
): { tone: ErrorTone; headline: string; detail: string | null; retryable: boolean } {
  const tone = errorTone(error)
  const serverText = error instanceof AbeiApiError ? (error.detail ?? error.title ?? null) : null

  switch (tone) {
    case 'auth':
      return {
        tone,
        headline: '登录已失效，需要重新填一次令牌',
        detail: serverText,
        retryable: false,
      }
    case 'offline':
      return {
        tone,
        headline: '连不上账本服务',
        detail: serverText ?? '阿贝在，但它连不上后面的账本。稍后再试一次。',
        retryable: true,
      }
    case 'confirm':
      return {
        tone,
        headline: '这一步需要你确认',
        detail: serverText,
        retryable: false,
      }
    default:
      return { tone, headline: serverText ?? fallback, detail: null, retryable: true }
  }
}

function ToneIcon({ tone, className }: { tone: ErrorTone; className: string }) {
  if (tone === 'auth') return <Key aria-hidden className={className} />
  if (tone === 'offline') return <CloudSlash aria-hidden className={className} />
  return <Warning aria-hidden className={className} />
}

/** 连不上是暂时的，用「注意」色；真失败才用危险色。 */
function toneColor(tone: ErrorTone): string {
  return tone === 'offline' || tone === 'confirm' ? 'text-[var(--attention)]' : 'text-[var(--danger)]'
}

/** 区块级错误：占一整块的位置，替代本该出现的内容 */
export function ErrorState({
  message,
  error,
  onRetry,
}: {
  message: string
  /** 拿得到就传：有它才能按 reason 分情形说话，没有就退回 message。 */
  error?: unknown
  onRetry?: () => void
}) {
  const { tone, headline, detail, retryable } = describe(message, error)
  return (
    <div
      role="alert"
      className="flex min-h-16 flex-col items-center justify-center gap-3 px-3 py-8 text-center"
    >
      <ToneIcon tone={tone} className={`size-6 ${toneColor(tone)}`} />
      <div className="flex flex-col gap-1">
        <p className="text-sm text-[var(--text-secondary)]">{headline}</p>
        {detail && <p className="text-xs text-[var(--text-tertiary)]">{detail}</p>}
      </div>
      {onRetry && retryable && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          重试
        </Button>
      )}
    </div>
  )
}

/**
 * 行内错误：只占一行，用在「主内容还在、某个附属数据没拿到」的场合
 * （账户下拉挂了、汇总条挂了）。此前这段结构在七八个文件里各写各的，
 * 文案和重试按钮的样子都不一样。
 */
export function InlineError({
  message,
  error,
  onRetry,
}: {
  message: string
  error?: unknown
  onRetry?: () => void
}) {
  const { tone, headline, retryable } = describe(message, error)
  const color = toneColor(tone)
  const surface = tone === 'offline' || tone === 'confirm' ? 'bg-[var(--attention-soft)]' : 'bg-[var(--danger-soft)]'
  return (
    <div role="alert" className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs ${surface} ${color}`}>
      <ToneIcon tone={tone} className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">{headline}</span>
      {onRetry && retryable && (
        <Button variant="ghost" size="xs" className={color} onClick={onRetry}>
          重试
        </Button>
      )}
    </div>
  )
}
