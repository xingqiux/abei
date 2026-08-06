import { ExclamationTriangleIcon } from '@heroicons/react/20/solid'
import { Button } from '../ui/Button'

/** 区块级错误：占一整块的位置，替代本该出现的内容 */
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex min-h-16 flex-col items-center justify-center gap-3 px-3 py-8 text-center"
    >
      <ExclamationTriangleIcon aria-hidden className="size-6 text-[var(--danger)]" />
      <p className="text-sm text-[var(--text-secondary)]">{message}</p>
      {onRetry && (
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
export function InlineError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-center gap-2 rounded-md bg-[var(--danger-soft)] px-2.5 py-1.5 text-xs text-[var(--danger)]"
    >
      <ExclamationTriangleIcon aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">{message}</span>
      {onRetry && (
        <Button variant="ghost" size="xs" className="text-[var(--danger)]" onClick={onRetry}>
          重试
        </Button>
      )}
    </div>
  )
}
