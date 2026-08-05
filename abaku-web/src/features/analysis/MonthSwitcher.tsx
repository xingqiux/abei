import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/20/solid'
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
        className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--surface-hover)] text-[var(--text-primary)] hover:bg-[var(--surface-selected)]   "
      >
        <ChevronLeftIcon aria-hidden className="size-4" />
      </button>
      <div className="w-[96px] text-center text-[13px] font-semibold text-[var(--text-primary)] ">
        {formatMonthLabel(month)}
      </div>
      <button
        type="button"
        onClick={onNext}
        aria-label="下一月"
        className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--surface-hover)] text-[var(--text-primary)] hover:bg-[var(--surface-selected)]   "
      >
        <ChevronRightIcon aria-hidden className="size-4" />
      </button>
    </div>
  )
}
