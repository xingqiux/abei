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
        <div className="flex h-10 items-center justify-center text-[32px] text-gray-400" aria-hidden>
          {icon}
        </div>
      )}
      <div className="text-[13px] text-gray-500 dark:text-gray-400">{message}</div>
      {actionLabel && (
        <button
          type="button"
          onClick={onAction}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-[13px] font-semibold text-white shadow-sm hover:bg-indigo-500"
        >
          {actionLabel}
        </button>
      )}
    </div>
  )
}
