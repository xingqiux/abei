import type { Column } from './DataTable'
import { MoneyText } from '../abaku/MoneyText'
import { CategoryChip } from '../abaku/CategoryChip'
import { splitFlowLabel, splitSemantic, type TransactionSplitRow } from '../../lib/transactionGroup'

export function transactionColumns(): Column<TransactionSplitRow>[] {
  return [
    {
      key: 'desc',
      header: '描述',
      width: 'minmax(0,1fr)',
      cell: (row) => (
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-semibold text-[var(--text-primary)] ">{row.tx.description}</span>
          {row.tx.category_name && <CategoryChip label={row.tx.category_name} />}
        </span>
      ),
    },
    {
      key: 'flow',
      header: '账户',
      width: '200px',
      hideBelow: 'md',
      cell: (row) => (
        <span className="truncate text-[11.5px] text-[var(--text-secondary)] ">{splitFlowLabel(row.tx)}</span>
      ),
    },
    {
      key: 'amount',
      header: '金额',
      width: '128px',
      align: 'end',
      cell: (row) => (
        <MoneyText value={row.tx.amount} semantic={splitSemantic(row.tx)} symbol={row.tx.currency_symbol} />
      ),
    },
  ]
}
