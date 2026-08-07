import type { ReactNode } from 'react'
import { AbakuMark } from './AbakuMark'
import { LottieIcon, type LottieIconKind } from './LottieIcon'
import { Button } from '../ui/Button'

export function EmptyState({
  icon = <AbakuMark className="size-8" />,
  statusIcon,
  message,
  actionLabel,
  onAction,
  compact = false,
}: {
  /** 静态占位图，任意节点（emoji、heroicon、自绘 svg）。 */
  icon?: ReactNode
  /** 语义状态图标（加载中/收件箱等），走 `LottieIcon`。 */
  statusIcon?: LottieIconKind
  message: string
  actionLabel?: string
  onAction?: () => void
  /** 列表或图表内部的紧凑空态。 */
  compact?: boolean
}) {
  const staticIcon = (
    <div className="flex h-full items-center justify-center text-[32px] text-[var(--text-tertiary)]" aria-hidden>
      {icon}
    </div>
  )

  return (
    <div
      className={`relative flex flex-col items-center justify-center text-center ${compact ? 'gap-2 py-6' : 'gap-3 py-16'}`}
    >
      {statusIcon ? (
        <LottieIcon kind={statusIcon} size={40} />
      ) : (
        <div className="h-10">{staticIcon}</div>
      )}
      <p className="max-w-sm text-sm text-[var(--text-secondary)]">{message}</p>
      {actionLabel && (
        <Button variant="primary" size="sm" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  )
}
