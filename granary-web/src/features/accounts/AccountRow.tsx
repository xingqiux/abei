import { Link } from '@tanstack/react-router'
import { ArchiveBoxXMarkIcon, PencilIcon } from '@heroicons/react/20/solid'
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
    <div className="group flex h-8 items-center rounded-md px-2 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800">
      <Link to="/accounts/$accountId" params={{ accountId: account.id }} className="flex min-w-0 flex-1 items-center gap-3 text-[13px]">
        <div className="min-w-0 flex-1 truncate font-semibold text-gray-900 dark:text-gray-100">{a.name}</div>
        {tail && <span className="shrink-0 font-mono text-[11px] text-gray-500 dark:text-gray-400">•••• {tail}</span>}
        <div className="w-[130px] shrink-0 text-right font-mono" title={a.currency_code} style={{ color: balanceColorVar }}>{symbol}{formatAmount(balance)}</div>
        <div className="w-[90px] shrink-0 text-right text-[11px] text-gray-500 dark:text-gray-400">{lastActivity}</div>
      </Link>
      <div className="ml-1 flex w-[48px] justify-end opacity-0 group-hover:opacity-100 focus-within:opacity-100">
        <button type="button" title="编辑账户" aria-label={`编辑 ${a.name}`} onClick={onEdit} className="rounded p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"><PencilIcon aria-hidden className="size-3.5" /></button>
        <button type="button" title="归档账户" aria-label={`归档 ${a.name}`} onClick={onDelete} className="rounded p-1 text-red-500 hover:text-red-600"><ArchiveBoxXMarkIcon aria-hidden className="size-3.5" /></button>
      </div>
    </div>
  )
}
