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
        className="flex h-7 w-7 items-center justify-center rounded-md bg-gray-100 text-gray-900 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700"
      >
        <ChevronLeftIcon aria-hidden className="size-4" />
      </button>
      <div className="w-[96px] text-center text-[13px] font-semibold text-gray-900 dark:text-gray-100">
        {formatMonthLabel(month)}
      </div>
      <button
        type="button"
        onClick={onNext}
        aria-label="下一月"
        className="flex h-7 w-7 items-center justify-center rounded-md bg-gray-100 text-gray-900 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700"
      >
        <ChevronRightIcon aria-hidden className="size-4" />
      </button>
    </div>
  )
}
