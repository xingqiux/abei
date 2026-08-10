import type { Column } from './DataTable'
import { MoneyText } from '../abei/MoneyText'
import { CategoryChip } from '../abei/CategoryChip'
import { splitFlowLabel, splitSemantic, type TransactionSplitRow } from '../../lib/transactionGroup'

export interface TransactionColumnOptions {
  /** 画出日期列。按日分组时组头已经写了日期，这一列纯属重复 */
  showDate?: boolean
  /** 画出分类列。列对齐需要占位，空值写 `—`，不是每行挂一个「未分类」 */
  showCategory?: boolean
  /** 画出账户列。右侧详情面板开着时它让位——账户在面板里写得更全 */
  showAccount?: boolean
}

/** 对手方：支出看目标账户，收入看来源账户，都没有就退回描述 */
function counterpartyOf(row: TransactionSplitRow): string {
  const tx = row.tx
  const name = tx.type === 'deposit' ? tx.source_name : tx.destination_name
  return (name ?? '').trim() || tx.description
}

/** 付款/收款账户：支出看来源，收入看目标 */
function fundingOf(row: TransactionSplitRow): string {
  const tx = row.tx
  const name = tx.type === 'deposit' ? tx.destination_name : tx.source_name
  return (name ?? '').trim() || '—'
}

export function transactionColumns(options: TransactionColumnOptions = {}): Column<TransactionSplitRow>[] {
  const { showDate = false, showCategory = false, showAccount = false } = options
  const columns: Column<TransactionSplitRow>[] = []

  if (showDate) {
    columns.push({
      key: 'date',
      header: '日期',
      width: '52px',
      cell: (row) => (
        <span className="num text-[11.5px] text-[var(--text-secondary)]">{row.tx.date.slice(5, 10)}</span>
      ),
    })
  }

  columns.push({
    key: 'desc',
    header: '描述',
    width: 'minmax(0,1fr)',
    cell: (row) => (
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate font-semibold text-[var(--text-primary)] ">{row.tx.description}</span>
        {/* 分类单独成列时就别在描述后面再挂一遍 */}
        {!showCategory && row.tx.category_name && <CategoryChip label={row.tx.category_name} />}
      </span>
    ),
  })

  if (showCategory) {
    columns.push({
      key: 'category',
      header: '分类',
      width: '104px',
      hideBelow: 'md',
      cell: (row) =>
        row.tx.category_name ? (
          <CategoryChip label={row.tx.category_name} />
        ) : (
          <span className="text-[var(--text-tertiary)]">—</span>
        ),
    })
  }

  columns.push({
    key: 'flow',
    header: showAccount ? '对手方' : '账户',
    width: showAccount ? '160px' : '200px',
    hideBelow: 'md',
    cell: (row) => (
      <span className="truncate text-[11.5px] text-[var(--text-secondary)] ">
        {showAccount ? counterpartyOf(row) : splitFlowLabel(row.tx)}
      </span>
    ),
  })

  if (showAccount) {
    columns.push({
      key: 'account',
      header: '账户',
      width: '120px',
      hideBelow: 'lg',
      cell: (row) => (
        <span className="truncate text-[11.5px] text-[var(--text-secondary)] ">{fundingOf(row)}</span>
      ),
    })
  }

  columns.push({
    key: 'amount',
    header: '金额',
    width: '128px',
    align: 'end',
    cell: (row) => (
      <MoneyText value={row.tx.amount} semantic={splitSemantic(row.tx)} symbol={row.tx.currency_symbol} />
    ),
  })

  return columns
}
