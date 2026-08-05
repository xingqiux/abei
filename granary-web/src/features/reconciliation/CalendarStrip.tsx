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
      return 'color-mix(in srgb, light-dark(var(--color-emerald-600), var(--color-emerald-400)) 38%, light-dark(var(--color-gray-100), var(--color-gray-700)))'
    case 'diff':
      return 'color-mix(in srgb, light-dark(var(--color-amber-600), var(--color-amber-400)) 48%, light-dark(var(--color-gray-100), var(--color-gray-700)))'
    case 'pending':
      return 'color-mix(in srgb, light-dark(var(--color-red-600), var(--color-red-400)) 40%, light-dark(var(--color-gray-100), var(--color-gray-700)))'
    case 'none':
    default:
      return 'light-dark(var(--color-gray-100), var(--color-gray-700))'
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
      <div
        ref={gridRef}
        className="grid gap-1.5"
        style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(28px, 1fr))' }}
      >
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
              className="transition-transform"
              style={{
                aspectRatio: '1 / 1',
                borderRadius: 4,
                background: statusBackground(day.status),
                outline: isSelected ? '2px solid light-dark(var(--color-indigo-600), var(--color-indigo-500))' : 'none',
                outlineOffset: isSelected ? -2 : 0,
                border: 'none',
                cursor: 'pointer',
                padding: 0,
              }}
            />
          )
        })}
      </div>

      <div className="flex flex-wrap items-center gap-4 text-[11.5px] text-gray-500 dark:text-gray-400">
        {LEGEND.map((item) => (
          <span key={item.status} className="flex items-center gap-1.5">
            <span
              aria-hidden
              style={{
                display: 'inline-block',
                width: 10,
                height: 10,
                borderRadius: 3,
                background: statusBackground(item.status),
              }}
            />
            {item.label}
          </span>
        ))}
      </div>
    </div>
  )
}
