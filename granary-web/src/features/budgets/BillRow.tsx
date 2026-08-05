import type { Bill } from '../../api/schemas'
import { StatusChip } from '../../components/granary/StatusChip'
import { formatAmount } from '../../lib/format'
import { REPEAT_FREQ_LABELS, dateOnly } from './budgetsHelpers'

/** 订阅一行：名称、金额范围、周期、下次预计日期、active 状态 chip */
export function BillRow({ bill }: { bill: Bill }) {
  const a = bill.attributes
  const symbol = a.currency_symbol ?? a.currency_code ?? ''
  const amountRange =
    a.amount_min && a.amount_max
      ? a.amount_min === a.amount_max
        ? `${symbol}${formatAmount(a.amount_min)}`
        : `${symbol}${formatAmount(a.amount_min)} ~ ${symbol}${formatAmount(a.amount_max)}`
      : '—'
  const periodLabel = a.repeat_freq ? (REPEAT_FREQ_LABELS[a.repeat_freq] ?? a.repeat_freq) : '—'

  return (
    <div className="flex h-8 items-center gap-3 rounded-[4px] px-2 text-[12.5px]">
      <div className="min-w-0 flex-1 truncate" style={{ color: 'light-dark(var(--color-gray-900), var(--color-gray-100))' }}>
        {a.name}
      </div>
      <div className="font-mono tabular-nums w-[170px] shrink-0 text-right text-[11.5px]" style={{ color: 'light-dark(var(--color-gray-500), var(--color-gray-400))' }}>
        {amountRange}
      </div>
      <div className="w-[64px] shrink-0 text-center text-[11.5px]" style={{ color: 'light-dark(var(--color-gray-500), var(--color-gray-400))' }}>
        {periodLabel}
      </div>
      <div className="font-mono tabular-nums w-[90px] shrink-0 text-right text-[11.5px]" style={{ color: 'light-dark(var(--color-gray-500), var(--color-gray-400))' }}>
        {dateOnly(a.next_expected_match)}
      </div>
      <div className="w-[56px] shrink-0 text-right">
        <StatusChip label={a.active === false ? '停用' : '启用'} kind={a.active === false ? 'muted' : 'ok'} />
      </div>
    </div>
  )
}
