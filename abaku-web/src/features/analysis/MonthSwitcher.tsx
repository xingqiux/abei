import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/20/solid'
import { formatMonthLabel } from '../../lib/format'
import { IconButton } from '../../components/ui/Button'

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
      <IconButton label="上一月" variant="secondary" className="size-7" onClick={onPrev}>
        <ChevronLeftIcon aria-hidden className="size-4" />
      </IconButton>
      {/* aria-live：点箭头之后读屏要播出换到了哪个月，否则只听得到「按钮」 */}
      <div aria-live="polite" className="w-[96px] text-center text-[13px] font-semibold text-[var(--text-primary)]">
        {formatMonthLabel(month)}
      </div>
      <IconButton label="下一月" variant="secondary" className="size-7" onClick={onNext}>
        <ChevronRightIcon aria-hidden className="size-4" />
      </IconButton>
    </div>
  )
}
