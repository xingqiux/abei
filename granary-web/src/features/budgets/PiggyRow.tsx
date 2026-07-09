import type { PiggyBank } from '../../api/schemas'
import { ProgressBar } from '../../components/granary/ProgressBar'
import { formatAmount } from '../../lib/format'

/** 储蓄罐一行：名称、当前/目标金额进度条（琥珀填充）、剩余金额 */
export function PiggyRow({ piggyBank }: { piggyBank: PiggyBank }) {
  const a = piggyBank.attributes
  const symbol = a.currency_symbol ?? '¥'
  const current = Number(a.current_amount ?? 0)
  const target = a.target_amount ? Number(a.target_amount) : 0
  const hasTarget = target > 0
  const pct = hasTarget ? (current / target) * 100 : 0
  const left = a.left_to_save !== undefined && a.left_to_save !== null ? Number(a.left_to_save) : Math.max(target - current, 0)

  return (
    <div className="flex h-8 items-center gap-3 rounded-[4px] px-2 text-[12.5px]">
      <div className="min-w-0 flex-1 truncate" style={{ color: 'var(--g-ink)' }}>
        {a.name}
      </div>

      <div className="flex w-[180px] shrink-0 items-center">
        {hasTarget ? (
          <ProgressBar pct={pct} colorVar="var(--g-accent)" />
        ) : (
          <span className="text-[11px]" style={{ color: 'var(--g-ink-2)' }}>
            无目标金额
          </span>
        )}
      </div>

      <div className="font-num w-[170px] shrink-0 text-right" style={{ color: 'var(--g-ink)' }}>
        {symbol}
        {formatAmount(current)}
        {hasTarget && (
          <span style={{ color: 'var(--g-ink-2)' }}>
            {' '}
            / {symbol}
            {formatAmount(target)}
          </span>
        )}
      </div>

      <div className="font-num w-[110px] shrink-0 text-right text-[11.5px]" style={{ color: 'var(--g-ink-2)' }}>
        {hasTarget ? `剩 ${symbol}${formatAmount(left)}` : '—'}
      </div>
    </div>
  )
}
