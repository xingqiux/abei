import type { TransactionSplit } from '../../api/schemas'
import { CategoryChip } from './CategoryChip'
import { MoneyText } from './MoneyText'

export function TransactionRow({ tx }: { tx: TransactionSplit }) {
  return (
    <>
      {/* 桌面（>=768px）：原单行布局，规范 §4.2 */}
      <div className="hidden h-8 items-center gap-3 rounded-[4px] px-2 text-[12.5px] transition-colors hover:bg-[var(--g-surface-2)] md:flex">
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
      </div>

      {/* 移动端（<768px）：两行卡片式，规范 §4.2 —— 第一行 描述+金额，第二行 分类chip+账户流向 */}
      <div
        className="flex flex-col gap-1 rounded-[4px] px-2 py-2 text-[12.5px] transition-colors hover:bg-[var(--g-surface-2)] md:hidden"
      >
        <div className="flex items-center justify-between gap-2">
          <span
            className="min-w-0 flex-1 truncate"
            style={{ color: 'var(--g-ink)', fontWeight: 'var(--g-weight-demibold)' }}
          >
            {tx.description}
          </span>
          <span className="shrink-0">
            <MoneyText value={tx.amount} kind={tx.type} symbol={tx.currency_symbol} />
          </span>
        </div>
        <div className="flex min-w-0 items-center justify-between gap-2">
          {tx.category_name ? <CategoryChip label={tx.category_name} /> : <span />}
          <span
            className="min-w-0 truncate text-[11px]"
            style={{ color: 'var(--g-ink-2)' }}
          >
            {tx.source_name ?? '?'} → {tx.destination_name ?? '?'}
          </span>
        </div>
      </div>
    </>
  )
}
