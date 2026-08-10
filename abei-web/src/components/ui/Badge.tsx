import type { ReactNode } from 'react'

/**
 * 徽标。取自 tailwind-plus `elements/badges/flat-pill`。
 *
 * tone 直接对应语义 token，不另起一套颜色名——页面上只会出现
 * 「这是收入 / 这需要注意 / 这已完成」这几种意思，没有中立的「蓝色徽标」。
 */
export type BadgeTone = 'neutral' | 'brand' | 'income' | 'transfer' | 'attention' | 'done' | 'danger'

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-[var(--surface-hover)] text-[var(--text-secondary)]',
  brand: 'bg-[var(--brand-soft)] text-[var(--brand-text)]',
  income: 'bg-[var(--income-soft)] text-[var(--income)]',
  transfer: 'bg-[var(--transfer-soft)] text-[var(--transfer)]',
  attention: 'bg-[var(--attention-soft)] text-[var(--attention)]',
  done: 'bg-[var(--done-soft)] text-[var(--done)]',
  danger: 'bg-[var(--danger-soft)] text-[var(--danger)]',
}

export function Badge({
  children,
  tone = 'neutral',
  className = '',
}: {
  children: ReactNode
  tone?: BadgeTone
  className?: string
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ${TONES[tone]} ${className}`}
    >
      {children}
    </span>
  )
}
