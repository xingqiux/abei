import { Link } from '@tanstack/react-router'
import { ArchiveBoxXMarkIcon, ArrowPathIcon, PencilIcon } from '@heroicons/react/20/solid'
import type { Account } from '../../api/schemas'
import { formatAmount } from '../../lib/format'

/** 账户一行（32px）：名称、账号尾号（如有）、当前余额、最近活动日期；整行可点进详情 */
export function AccountRow({ account, balanceColorVar, onEdit, onToggleArchive }: { account: Account; balanceColorVar: string; onEdit: () => void; onToggleArchive: () => void }) {
  const a = account.attributes
  const archived = a.active === false
  const symbol = a.currency_symbol ?? a.currency_code ?? ''
  const tail = a.account_number ? a.account_number.slice(-4) : a.iban ? a.iban.slice(-4) : null
  const balance = a.current_balance ?? '0'
  const lastActivity = a.last_activity ? a.last_activity.slice(0, 10) : '—'

  return (
    <div data-testid="account-row" className={`group flex h-8 items-center rounded-md px-2 transition-colors hover:bg-[var(--surface-hover)] ${archived ? 'opacity-70' : ''}`}>
      <Link to="/accounts/$accountId" params={{ accountId: account.id }} className="flex min-w-0 flex-1 items-center gap-3 text-[13px]">
        <div className="min-w-0 flex-1 truncate font-semibold text-[var(--text-primary)] ">{a.name}</div>
        {archived && <span className="shrink-0 rounded bg-[var(--surface-selected)] px-1.5 py-0.5 text-[10.5px] text-[var(--text-secondary)] ">已归档</span>}
        {tail && <span className="shrink-0 font-mono text-[11px] text-[var(--text-secondary)] ">•••• {tail}</span>}
        <div className="w-[130px] shrink-0 text-right font-mono" title={a.currency_code} style={{ color: balanceColorVar }}>{symbol}{formatAmount(balance)}</div>
        <div className="w-[90px] shrink-0 text-right text-[11px] text-[var(--text-secondary)] ">{lastActivity}</div>
      </Link>
      <div className="ml-1 flex w-[48px] justify-end opacity-0 group-hover:opacity-100 focus-within:opacity-100">
        <button type="button" title="编辑账户" aria-label={`编辑 ${a.name}`} onClick={onEdit} className="rounded p-1 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] "><PencilIcon aria-hidden className="size-3.5" /></button>
        {archived ? (
          <button type="button" title="恢复账户" aria-label={`恢复 ${a.name}`} onClick={onToggleArchive} className="rounded p-1 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] "><ArrowPathIcon aria-hidden className="size-3.5" /></button>
        ) : (
          <button type="button" title="归档账户" aria-label={`归档 ${a.name}`} onClick={onToggleArchive} className="rounded p-1 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] "><ArchiveBoxXMarkIcon aria-hidden className="size-3.5" /></button>
        )}
      </div>
    </div>
  )
}
