import type { ReconciliationDay } from '../../api/schemas'
import { formatAmount } from '../../lib/format'
import { useStaggerInView } from '../../motion/useStaggerInView'
import { absoluteDecimalString, compareDecimalStrings } from '../../lib/decimal'

const STATUS_LABEL: Record<ReconciliationDay['status'], string> = {
  reconciled: '已对账',
  diff: '存在差异',
  none: '无交易',
  pending: '未对账',
}

/** 状态 → 背景色：与 surface-2 做 color-mix，语义色只做"底色调子"而非高饱和色面 */
function statusBackground(status: ReconciliationDay['status']): string {
  switch (status) {
    case 'reconciled':
      return 'color-mix(in srgb, var(--done) 38%, var(--surface-hover))'
    case 'diff':
      return 'color-mix(in srgb, var(--attention) 48%, var(--surface-hover))'
    case 'pending':
      return 'color-mix(in srgb, var(--danger) 40%, var(--surface-hover))'
    case 'none':
    default:
      return 'var(--surface-hover)'
  }
}

const LEGEND: { status: ReconciliationDay['status']; label: string }[] = [
  { status: 'reconciled', label: '已对账' },
  { status: 'diff', label: '存在差异' },
  { status: 'none', label: '无交易' },
  { status: 'pending', label: '未对账' },
]

export function CalendarStrip({
  days,
  selected,
  onSelect,
}: {
  days: ReconciliationDay[]
  selected: string | null
  onSelect: (date: string) => void
}) {
  const gridRef = useStaggerInView<HTMLDivElement>([days.length > 0], { stagger: 0.02 })

  return (
    <div className="flex flex-col gap-3">
      <div ref={gridRef} className="grid grid-cols-[repeat(auto-fill,minmax(28px,1fr))] gap-1.5">
        {days.map((day) => {
          const isSelected = day.date === selected
          const totals = day.currency_totals.length > 0
            ? day.currency_totals
            : day.net !== null
              ? [{ currency_code: '', currency_symbol: '', income: day.income ?? '0', expense: day.expense ?? '0', net: day.net }]
              : []
          const netLabel = totals.length === 0
            ? '无金额'
            : totals.map((total) => {
              const comparison = compareDecimalStrings(total.net, '0')
              return `${comparison > 0 ? '+' : comparison < 0 ? '-' : ''}${total.currency_symbol}${formatAmount(absoluteDecimalString(total.net))}${total.currency_code ? ` ${total.currency_code}` : ''}`
            }).join(' / ')
          return (
            <button
              key={day.date}
              type="button"
              onClick={() => onSelect(day.date)}
              title={`${day.date} · ${STATUS_LABEL[day.status]} · 净额 ${netLabel}`}
              aria-label={`${day.date} ${STATUS_LABEL[day.status]}`}
              aria-pressed={isSelected}
              /* 选中用 ring、聚焦用 outline：两者叠加时不会互相顶掉。
                 原先选中态直接写死 outline，键盘 Tab 到未选中的格子上完全没有反馈 */
              className={`aspect-square cursor-pointer rounded border-0 p-0 transition-transform focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--focus-ring)] ${
                isSelected ? 'ring-2 ring-[var(--brand)] ring-inset' : ''
              }`}
              style={{ background: statusBackground(day.status) }}
            />
          )
        })}
      </div>

      <div className="flex flex-wrap items-center gap-4 text-[11.5px] text-[var(--text-secondary)]">
        {LEGEND.map((item) => (
          <span key={item.status} className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block size-2.5 rounded-xs" style={{ background: statusBackground(item.status) }} />
            {item.label}
          </span>
        ))}
      </div>
    </div>
  )
}
