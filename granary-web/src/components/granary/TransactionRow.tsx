import { useEffect, useRef, useState } from 'react'
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import type { TransactionSplit } from '../../api/schemas'
import { CategoryChip } from './CategoryChip'
import { MoneyText } from './MoneyText'

export interface TransactionRowIds {
  groupId: string
  journalId: string
}

/**
 * 交易行（规范 §4.2）：桌面 32px 单行 / 移动端两行卡片。
 * 可选传入 groupId/journalId 与 onEdit/onDelete 开启行操作；
 * 不传则完全只读（报表 Top10 等场景保持现状）。
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
  const actionable = !!ids && (!!onEdit || !!onDelete)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    function onPointerDown(e: PointerEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [menuOpen])

  const actionsDesktop = actionable && (
    <div className="flex w-[56px] shrink-0 items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
      {onEdit && (
        <button
          type="button"
          aria-label="编辑"
          onClick={() => onEdit(ids)}
          className="rounded p-1"
          style={{ color: 'var(--g-ink-2)' }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = 'var(--g-ink)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = 'var(--g-ink-2)'
          }}
        >
          <Pencil size={14} strokeWidth={1.75} />
        </button>
      )}
      {onDelete && (
        <button
          type="button"
          aria-label="删除"
          onClick={() => onDelete(ids)}
          className="rounded p-1"
          style={{ color: 'var(--g-ink-2)' }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = 'var(--g-danger)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = 'var(--g-ink-2)'
          }}
        >
          <Trash2 size={14} strokeWidth={1.75} />
        </button>
      )}
    </div>
  )

  const actionsMobile = actionable && (
    <div ref={menuRef} className="relative shrink-0">
      <button
        type="button"
        aria-label="更多操作"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((v) => !v)}
        className="rounded p-1"
        style={{ color: 'var(--g-ink-2)' }}
      >
        <MoreHorizontal size={16} strokeWidth={1.75} />
      </button>
      {menuOpen && (
        <div
          className="absolute right-0 top-full z-40 mt-1 min-w-[100px] overflow-hidden rounded-[6px] py-0.5"
          style={{
            background: 'var(--g-surface)',
            border: '1px solid var(--g-border)',
            boxShadow: 'var(--g-shadow)',
          }}
          role="menu"
        >
          {onEdit && (
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px]"
              style={{ color: 'var(--g-ink)' }}
              onClick={() => {
                setMenuOpen(false)
                onEdit(ids)
              }}
            >
              <Pencil size={13} strokeWidth={1.75} />
              编辑
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px]"
              style={{ color: 'var(--g-danger)' }}
              onClick={() => {
                setMenuOpen(false)
                onDelete(ids)
              }}
            >
              <Trash2 size={13} strokeWidth={1.75} />
              删除
            </button>
          )}
        </div>
      )}
    </div>
  )

  return (
    <>
      {/* 桌面（>=768px）：原单行布局，规范 §4.2 */}
      <div className="group hidden h-8 items-center gap-3 rounded-[4px] px-2 text-[12.5px] transition-colors hover:bg-[var(--g-surface-2)] md:flex">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span
            className="truncate"
            style={{ color: 'var(--g-ink)', fontWeight: 'var(--g-weight-demibold)' }}
          >
            {tx.description}
          </span>
          {tx.category_name && <CategoryChip label={tx.category_name} />}
        </div>

        <div
          className="hidden shrink-0 truncate text-[11.5px] sm:block"
          style={{ color: 'var(--g-ink-2)', maxWidth: 200 }}
        >
          {tx.source_name ?? '?'} → {tx.destination_name ?? '?'}
        </div>

        <div className="w-[110px] shrink-0 text-right">
          <MoneyText value={tx.amount} kind={tx.type} symbol={tx.currency_symbol} />
        </div>
        {actionsDesktop}
      </div>

      {/* 移动端（<768px）：两行卡片式，规范 §4.2 —— 第一行 描述+金额，第二行 分类chip+账户流向 */}
      <div className="flex flex-col gap-1 rounded-[4px] px-2 py-2 text-[12.5px] transition-colors hover:bg-[var(--g-surface-2)] md:hidden">
        <div className="flex items-center justify-between gap-2">
          <span
            className="min-w-0 flex-1 truncate"
            style={{ color: 'var(--g-ink)', fontWeight: 'var(--g-weight-demibold)' }}
          >
            {tx.description}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <MoneyText value={tx.amount} kind={tx.type} symbol={tx.currency_symbol} />
            {actionsMobile}
          </div>
        </div>
        <div className="flex min-w-0 items-center justify-between gap-2">
          {tx.category_name ? <CategoryChip label={tx.category_name} /> : <span />}
          <span className="min-w-0 truncate text-[11px]" style={{ color: 'var(--g-ink-2)' }}>
            {tx.source_name ?? '?'} → {tx.destination_name ?? '?'}
          </span>
        </div>
      </div>
    </>
  )
}
