import type { Account } from '../../api/schemas'
import { formatAmount } from '../../lib/format'

/** 账户一行（32px）：名称、账号尾号（如有）、当前余额（语义色由调用方决定）、最近活动日期 */
export function AccountRow({ account, balanceColorVar }: { account: Account; balanceColorVar: string }) {
  const a = account.attributes
  const symbol = a.currency_symbol ?? '¥'
  const tail = a.account_number ? a.account_number.slice(-4) : a.iban ? a.iban.slice(-4) : null
  const balance = Number(a.current_balance ?? 0)
  const lastActivity = a.last_activity ? a.last_activity.slice(0, 10) : '—'

  return (
    <div
      className="flex h-8 items-center gap-3 rounded-[4px] px-2 text-[12.5px] transition-colors hover:bg-[var(--g-surface-2)]"
    >
      <div className="min-w-0 flex-1 truncate" style={{ color: 'var(--g-ink)', fontWeight: 'var(--g-weight-demibold)' }}>
        {a.name}
      </div>
      {tail && (
        <span className="font-num shrink-0 text-[11px]" style={{ color: 'var(--g-ink-2)' }}>
          •••• {tail}
        </span>
      )}
      <div className="font-num w-[130px] shrink-0 text-right" style={{ color: balanceColorVar }}>
        {symbol}
        {formatAmount(balance)}
      </div>
      <div className="w-[90px] shrink-0 text-right text-[11px]" style={{ color: 'var(--g-ink-2)' }}>
        {lastActivity}
      </div>
    </div>
  )
}
