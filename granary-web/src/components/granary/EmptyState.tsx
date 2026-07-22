import type { ReactNode } from 'react'
import { LottieIcon, type LottieIconKind } from './LottieIcon'

export function EmptyState({
  icon = '🌾',
  lottie,
  message,
  actionLabel,
  onAction,
}: {
  icon?: ReactNode
  lottie?: LottieIconKind
  message: string
  actionLabel?: string
  onAction?: () => void
}) {
  return (
    <div
      className="relative flex flex-col items-center justify-center gap-3 py-16 text-center"
    >
      {lottie ? (
        <LottieIcon kind={lottie} size={40} />
      ) : (
        <div className="flex h-10 items-center justify-center" style={{ fontSize: 32, color: 'var(--g-ink-2)' }} aria-hidden>
          {icon}
        </div>
      )}
      <div style={{ color: 'var(--g-ink-2)', fontSize: 13 }}>{message}</div>
      {actionLabel && (
        <button
          type="button"
          onClick={onAction}
          className="rounded-[6px] px-3 py-1.5 text-[12.5px]"
          style={{ background: 'var(--g-accent)', color: 'var(--g-accent-ink)', fontWeight: 'var(--g-weight-demibold)' }}
        >
          {actionLabel}
        </button>
      )}
    </div>
  )
}
