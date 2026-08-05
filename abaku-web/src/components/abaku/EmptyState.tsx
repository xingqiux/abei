import type { ReactNode } from 'react'
import { lottieArt, type LottieArtName } from '../../assets/lottie'
import { AbakuMark } from './AbakuMark'
import { LottieArt } from './LottieArt'
import { LottieIcon, type LottieIconKind } from './LottieIcon'

export function EmptyState({
  icon = <AbakuMark className="size-8" />,
  statusIcon,
  art,
  message,
  actionLabel,
  onAction,
}: {
  /** 静态占位图，任意节点（emoji、heroicon、自绘 svg）。 */
  icon?: ReactNode
  /** 语义状态图标（加载中/收件箱等），走 `LottieIcon`。 */
  statusIcon?: LottieIconKind
  /** Lottie 插画，比 icon/statusIcon 优先。不播时退回 `icon`。 */
  art?: LottieArtName
  message: string
  actionLabel?: string
  onAction?: () => void
}) {
  const staticIcon = (
    <div className="flex h-full items-center justify-center text-[32px] text-[var(--text-tertiary)]" aria-hidden>
      {icon}
    </div>
  )

  return (
    <div
      className="relative flex flex-col items-center justify-center gap-3 py-16 text-center"
    >
      {art ? (
        <LottieArt src={lottieArt[art]} className="size-28" fallback={staticIcon} />
      ) : statusIcon ? (
        <LottieIcon kind={statusIcon} size={40} />
      ) : (
        <div className="h-10">{staticIcon}</div>
      )}
      <div className="text-[13px] text-[var(--text-secondary)] ">{message}</div>
      {actionLabel && (
        <button
          type="button"
          onClick={onAction}
          className="rounded-md bg-[var(--brand)] px-3 py-1.5 text-[13px] font-semibold text-[var(--brand-on)] shadow-sm hover:bg-[var(--brand-hover)]"
        >
          {actionLabel}
        </button>
      )}
    </div>
  )
}
