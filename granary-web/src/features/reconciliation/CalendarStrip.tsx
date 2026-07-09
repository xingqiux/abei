import type { ReconciliationDay } from '../../api/schemas'
import { formatAmount } from '../../lib/format'
import { useStaggerInView } from '../../motion/useStaggerInView'

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
      return 'color-mix(in srgb, var(--g-income) 38%, var(--g-surface-2))'
    case 'diff':
      return 'color-mix(in srgb, var(--g-warn) 48%, var(--g-surface-2))'
    case 'pending':
      return 'color-mix(in srgb, var(--g-danger) 40%, var(--g-surface-2))'
    case 'none':
    default:
      return 'var(--g-surface-2)'
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
          const net = Number(day.net)
          return (
            <button
              key={day.date}
              type="button"
              onClick={() => onSelect(day.date)}
              title={`${day.date} · ${STATUS_LABEL[day.status]} · 净额 ${net >= 0 ? '+' : '-'}¥${formatAmount(net)}`}
              aria-label={`${day.date} ${STATUS_LABEL[day.status]}`}
              aria-pressed={isSelected}
              className="transition-transform"
              style={{
                aspectRatio: '1 / 1',
                borderRadius: 4,
                background: statusBackground(day.status),
                outline: isSelected ? '2px solid var(--g-accent)' : 'none',
                outlineOffset: isSelected ? -2 : 0,
                border: 'none',
                cursor: 'pointer',
                padding: 0,
              }}
            />
          )
        })}
      </div>

      <div className="flex flex-wrap items-center gap-4 text-[11.5px]" style={{ color: 'var(--g-ink-2)' }}>
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
