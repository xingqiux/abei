import { Link } from '@tanstack/react-router'
import { Pencil, Trash2 } from 'lucide-react'
import type { Account } from '../../api/schemas'
import { formatAmount } from '../../lib/format'

/** 账户一行（32px）：名称、账号尾号（如有）、当前余额（语义色由调用方决定）、最近活动日期；整行可点进详情 */
export function AccountRow({ account, balanceColorVar, onEdit, onDelete }: { account: Account; balanceColorVar: string; onEdit: () => void; onDelete: () => void }) {
  const a = account.attributes
  const symbol = a.currency_symbol ?? a.currency_code ?? ''
  const tail = a.account_number ? a.account_number.slice(-4) : a.iban ? a.iban.slice(-4) : null
  const balance = a.current_balance ?? '0'
  const lastActivity = a.last_activity ? a.last_activity.slice(0, 10) : '—'

  return (
    <div className="group flex h-8 items-center rounded-[4px] px-2 transition-colors hover:bg-[var(--g-surface-2)]">
      <Link to="/accounts/$accountId" params={{ accountId: account.id }} className="flex min-w-0 flex-1 items-center gap-3 text-[12.5px]" style={{ textDecoration: 'none' }}>
        <div className="min-w-0 flex-1 truncate" style={{ color: 'var(--g-ink)', fontWeight: 'var(--g-weight-demibold)' }}>{a.name}</div>
        {tail && <span className="font-num shrink-0 text-[11px]" style={{ color: 'var(--g-ink-2)' }}>•••• {tail}</span>}
        <div className="font-num w-[130px] shrink-0 text-right" title={a.currency_code} style={{ color: balanceColorVar }}>{symbol}{formatAmount(balance)}</div>
        <div className="w-[90px] shrink-0 text-right text-[11px]" style={{ color: 'var(--g-ink-2)' }}>{lastActivity}</div>
      </Link>
      <div className="ml-1 flex w-[48px] justify-end opacity-0 group-hover:opacity-100 focus-within:opacity-100">
        <button type="button" title="编辑账户" aria-label={`编辑 ${a.name}`} onClick={onEdit} className="rounded p-1" style={{ color: 'var(--g-ink-2)' }}><Pencil size={13} /></button>
        <button type="button" title="删除账户" aria-label={`删除 ${a.name}`} onClick={onDelete} className="rounded p-1" style={{ color: 'var(--g-danger)' }}><Trash2 size={13} /></button>
      </div>
    </div>
  )
}
