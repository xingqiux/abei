import { ChevronLeft, ChevronRight } from 'lucide-react'
import { formatMonthLabel } from '../../lib/format'

/** 报表页顶部月份切换：← 2026年7月 → */
export function MonthSwitcher({
  month,
  onPrev,
  onNext,
}: {
  month: Date
  onPrev: () => void
  onNext: () => void
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onPrev}
        aria-label="上一月"
        className="flex h-7 w-7 items-center justify-center rounded-[6px]"
        style={{ background: 'var(--g-surface-2)', color: 'var(--g-ink)' }}
      >
        <ChevronLeft aria-hidden size={16} />
      </button>
      <div className="w-[96px] text-center text-[13px]" style={{ color: 'var(--g-ink)', fontWeight: 'var(--g-weight-demibold)' }}>
        {formatMonthLabel(month)}
      </div>
      <button
        type="button"
        onClick={onNext}
        aria-label="下一月"
        className="flex h-7 w-7 items-center justify-center rounded-[6px]"
        style={{ background: 'var(--g-surface-2)', color: 'var(--g-ink)' }}
      >
        <ChevronRight aria-hidden size={16} />
      </button>
    </div>
  )
}
