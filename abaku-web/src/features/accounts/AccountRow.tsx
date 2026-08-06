import { Link } from '@tanstack/react-router'
import { ArchiveBoxXMarkIcon, ArrowPathIcon, PencilIcon } from '@heroicons/react/20/solid'
import type { Account } from '../../api/schemas'
import { formatAmount } from '../../lib/format'
import { Badge } from '../../components/ui/Badge'
import { IconButton } from '../../components/ui/Button'

/** 负债账户的余额用警示色，其余用正文色 */
export type BalanceTone = 'neutral' | 'danger'

/** 账户一行（32px）：名称、账号尾号（如有）、当前余额、最近活动日期；整行可点进详情 */
export function AccountRow({ account, balanceTone, onEdit, onToggleArchive }: { account: Account; balanceTone: BalanceTone; onEdit: () => void; onToggleArchive: () => void }) {
  const a = account.attributes
  const archived = a.active === false
  const symbol = a.currency_symbol ?? a.currency_code ?? ''
  const tail = a.account_number ? a.account_number.slice(-4) : a.iban ? a.iban.slice(-4) : null
  const balance = a.current_balance ?? '0'
  const lastActivity = a.last_activity ? a.last_activity.slice(0, 10) : '—'

  return (
    <div data-testid="account-row" className={`group flex h-8 items-center rounded-md px-2 transition-colors hover:bg-[var(--surface-hover)] ${archived ? 'opacity-70' : ''}`}>
      <Link to="/accounts/$accountId" params={{ accountId: account.id }} className="flex min-w-0 flex-1 items-center gap-3 text-[13px]">
        <div className="min-w-0 flex-1 truncate font-semibold text-[var(--text-primary)]">{a.name}</div>
        {archived && <Badge>已归档</Badge>}
        {tail && <span className="shrink-0 font-mono text-[11px] text-[var(--text-secondary)]">•••• {tail}</span>}
        <div
          className={`w-[130px] shrink-0 text-right font-mono tabular-nums ${
            balanceTone === 'danger' ? 'text-[var(--danger)]' : 'text-[var(--text-primary)]'
          }`}
          title={a.currency_code}
        >
          {symbol}{formatAmount(balance)}
        </div>
        <div className="w-[90px] shrink-0 text-right text-[11px] text-[var(--text-secondary)]">{lastActivity}</div>
      </Link>
      {/* 触屏没有 hover，所以只在 sm 以上藏起来 */}
      <div className="ml-1 flex w-[48px] justify-end sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100">
        <IconButton label={`编辑 ${a.name}`} className="size-6" onClick={onEdit}>
          <PencilIcon aria-hidden className="size-3.5" />
        </IconButton>
        {archived ? (
          <IconButton label={`恢复 ${a.name}`} className="size-6" onClick={onToggleArchive}>
            <ArrowPathIcon aria-hidden className="size-3.5" />
          </IconButton>
        ) : (
          <IconButton label={`归档 ${a.name}`} className="size-6" onClick={onToggleArchive}>
            <ArchiveBoxXMarkIcon aria-hidden className="size-3.5" />
          </IconButton>
        )}
      </div>
    </div>
  )
}
