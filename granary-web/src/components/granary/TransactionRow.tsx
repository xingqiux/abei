import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { EllipsisHorizontalIcon, EyeIcon, PencilIcon, TrashIcon } from '@heroicons/react/20/solid'
import type { TransactionSplit } from '../../api/schemas'
import { CategoryChip } from './CategoryChip'
import { MoneyText } from './MoneyText'

export interface TransactionRowIds {
  groupId: string
  journalId: string
}

/**
 * 交易行（规范 §4.2）：桌面 32px 单行 / 移动端两行卡片。
 * 传入 groupId/journalId 后整行进入详情；编辑和删除保留在次级操作菜单。
 */
export function TransactionRow({
  tx,
  ids,
  onEdit,
  onDelete,
}: {
  tx: TransactionSplit
  ids?: TransactionRowIds
  onEdit?: (ids: TransactionRowIds) => void
  onDelete?: (ids: TransactionRowIds) => void
}) {
  // reconciliation：按 source/destination 账户类型推断增减，避免「A→A ¥0.01」无正负号
  const isRecon = tx.type === 'reconciliation'
  const srcType = String((tx as { source_type?: string }).source_type ?? '')
  const destType = String((tx as { destination_type?: string }).destination_type ?? '')
  const reconIsDecrease =
    isRecon &&
    (destType.toLowerCase().includes('reconciliation') ||
      (!srcType.toLowerCase().includes('reconciliation') && destType !== ''))
  const moneyKind = isRecon ? (reconIsDecrease ? 'withdrawal' : 'deposit') : tx.type
  const flowLabel = isRecon
    ? reconIsDecrease
      ? `${tx.source_name ?? '?'} → 对账账户`
      : `对账账户 → ${tx.destination_name ?? '?'}`
    : `${tx.source_name ?? '?'} → ${tx.destination_name ?? '?'}`

  const desktopContent = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate font-semibold text-gray-900 dark:text-gray-100">
          {tx.description}
        </span>
        {tx.category_name && <CategoryChip label={tx.category_name} />}
      </div>
      <div className="hidden max-w-[200px] shrink-0 truncate text-[11.5px] text-gray-500 sm:block dark:text-gray-400">
        {flowLabel}
      </div>
      <div className="w-[110px] shrink-0 text-right">
        <MoneyText value={tx.amount} kind={moneyKind} symbol={tx.currency_symbol} />
      </div>
    </>
  )

  const mobileContent = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 flex-1 truncate font-semibold text-gray-900 dark:text-gray-100">
          {tx.description}
        </span>
        <MoneyText value={tx.amount} kind={moneyKind} symbol={tx.currency_symbol} />
      </div>
      <div className="flex min-w-0 items-center justify-between gap-2">
        {tx.category_name ? <CategoryChip label={tx.category_name} /> : <span />}
        <span className="min-w-0 truncate text-[11px] text-gray-500 dark:text-gray-400">
          {flowLabel}
        </span>
      </div>
    </>
  )

  return (
    <>
      {/* 桌面（>=768px）：原单行布局，规范 §4.2 */}
      <div className="group hidden h-8 items-center gap-3 rounded-md px-2 text-[13px] transition-colors hover:bg-gray-50 md:flex dark:hover:bg-gray-800">
        {ids ? (
          <Link to="/transactions" search={{ transaction: Number(ids.groupId) }} aria-label={`查看交易 ${tx.description}`} className="flex min-w-0 flex-1 items-center gap-3 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
            {desktopContent}
          </Link>
        ) : desktopContent}
        {ids && (onEdit || onDelete) && <TransactionActions ids={ids} onEdit={onEdit} onDelete={onDelete} desktop />}
      </div>

      {/* 移动端（<768px）：两行卡片式，规范 §4.2 —— 第一行 描述+金额，第二行 分类chip+账户流向 */}
      <div className="group flex items-start rounded-md px-2 py-2 text-[13px] transition-colors hover:bg-gray-50 md:hidden dark:hover:bg-gray-800">
        {ids ? (
          <Link to="/transactions" search={{ transaction: Number(ids.groupId) }} aria-label={`查看交易 ${tx.description}`} className="flex min-w-0 flex-1 flex-col gap-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
            {mobileContent}
          </Link>
        ) : <div className="flex min-w-0 flex-1 flex-col gap-1">{mobileContent}</div>}
        {ids && (onEdit || onDelete) && <TransactionActions ids={ids} onEdit={onEdit} onDelete={onDelete} />}
      </div>
    </>
  )
}

function TransactionActions({
  ids,
  onEdit,
  onDelete,
  desktop = false,
}: {
  ids: TransactionRowIds
  onEdit?: (ids: TransactionRowIds) => void
  onDelete?: (ids: TransactionRowIds) => void
  desktop?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  return (
    <div ref={ref} className={`relative shrink-0 ${desktop ? 'opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100' : 'ml-1'}`}>
      <button type="button" aria-label="交易操作" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="rounded p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
        <EllipsisHorizontalIcon aria-hidden className="size-4" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 min-w-[138px] overflow-hidden rounded-lg bg-white py-1 whitespace-nowrap shadow-lg ring-1 ring-gray-200 dark:bg-gray-900 dark:ring-gray-700" role="menu">
          <Link to="/transactions" search={{ transaction: Number(ids.groupId) }} role="menuitem" className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] text-gray-900 hover:bg-gray-50 dark:text-gray-100 dark:hover:bg-gray-800" onClick={() => setOpen(false)}>
            <EyeIcon aria-hidden className="size-3.5 text-gray-400" />
            查看详情
          </Link>
          {onEdit && (
            <button type="button" role="menuitem" className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] text-gray-900 hover:bg-gray-50 dark:text-gray-100 dark:hover:bg-gray-800" onClick={() => { setOpen(false); onEdit(ids) }}>
              <PencilIcon aria-hidden className="size-3.5 text-gray-400" />
              编辑
            </button>
          )}
          {onDelete && (
            <button type="button" role="menuitem" className="flex w-full items-center gap-2 border-t border-gray-200 px-2.5 py-1.5 text-left text-[13px] text-red-600 hover:bg-red-50 dark:border-gray-700 dark:text-red-400 dark:hover:bg-red-500/10" onClick={() => { setOpen(false); onDelete(ids) }}>
              <TrashIcon aria-hidden className="size-3.5" />
              移入回收站
            </button>
          )}
        </div>
      )}
    </div>
  )
}
