import { Link } from '@tanstack/react-router'
import { Archive, ArrowsClockwise, PencilSimple } from '@phosphor-icons/react'
import type { Account } from '../../api/schemas'
import { formatAmount } from '../../lib/format'
import { Badge } from '../../components/ui/Badge'
import { IconButton } from '../../components/ui/Button'

/**
 * 负债账户的余额用 `--liability`（琥珀），其余用正文色。
 * 原先用的是 `--danger`——那个 token 只给删除类操作，余额不是「危险」。
 */
export type BalanceTone = 'neutral' | 'liability'

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
        {/* 卡号尾号是机读字段，留 mono */}
        {tail && <span className="shrink-0 font-mono text-[11px] text-[var(--text-secondary)]">•••• {tail}</span>}
        <div
          className={`num w-[130px] shrink-0 text-right ${
            balanceTone === 'liability' ? 'text-[var(--liability)]' : 'text-[var(--text-primary)]'
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
          <PencilSimple aria-hidden className="size-3.5" />
        </IconButton>
        {archived ? (
          <IconButton label={`恢复 ${a.name}`} className="size-6" onClick={onToggleArchive}>
            <ArrowsClockwise aria-hidden className="size-3.5" />
          </IconButton>
        ) : (
          <IconButton label={`归档 ${a.name}`} className="size-6" onClick={onToggleArchive}>
            <Archive aria-hidden className="size-3.5" />
          </IconButton>
        )}
      </div>
    </div>
  )
}
