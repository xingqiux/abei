import type { PiggyBank } from '../../api/schemas'
import { ProgressBar } from '../../components/granary/ProgressBar'
import { formatAmount } from '../../lib/format'
import { compareDecimalStrings, decimalPercentage, subtractDecimalStrings } from '../../lib/decimal'

/** 储蓄罐一行：名称、当前/目标金额进度条（琥珀填充）、剩余金额 */
export function PiggyRow({ piggyBank }: { piggyBank: PiggyBank }) {
  const a = piggyBank.attributes
  const symbol = a.currency_symbol ?? a.currency_code ?? ''
  const current = a.current_amount ?? '0'
  const target = a.target_amount ?? '0'
  const hasTarget = compareDecimalStrings(target, '0') > 0
  const pct = hasTarget ? decimalPercentage(current, target) : 0
  const calculatedLeft = subtractDecimalStrings(target, current)
  const left = a.left_to_save ?? (compareDecimalStrings(calculatedLeft, '0') > 0 ? calculatedLeft : '0')

  return (
    <div className="flex h-8 items-center gap-3 rounded-[4px] px-2 text-[12.5px]">
      <div className="min-w-0 flex-1 truncate" style={{ color: 'light-dark(var(--color-gray-900), var(--color-gray-100))' }}>
        {a.name}
      </div>

      <div className="flex w-[180px] shrink-0 items-center">
        {hasTarget ? (
          <ProgressBar pct={pct} colorVar="light-dark(var(--color-indigo-600), var(--color-indigo-500))" />
        ) : (
          <span className="text-[11px]" style={{ color: 'light-dark(var(--color-gray-500), var(--color-gray-400))' }}>
            无目标金额
          </span>
        )}
      </div>

      <div className="font-mono tabular-nums w-[170px] shrink-0 text-right" style={{ color: 'light-dark(var(--color-gray-900), var(--color-gray-100))' }}>
        {symbol}
        {formatAmount(current)}
        {hasTarget && (
          <span style={{ color: 'light-dark(var(--color-gray-500), var(--color-gray-400))' }}>
            {' '}
            / {symbol}
            {formatAmount(target)}
          </span>
        )}
      </div>

      <div className="font-mono tabular-nums w-[110px] shrink-0 text-right text-[11.5px]" style={{ color: 'light-dark(var(--color-gray-500), var(--color-gray-400))' }}>
        {hasTarget ? `剩 ${symbol}${formatAmount(left)}` : '—'}
      </div>
    </div>
  )
}
