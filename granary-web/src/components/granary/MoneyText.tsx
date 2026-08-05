import { formatSignedAmount, kindColorClass, type TransactionKind } from '../../lib/format'

export function MoneyText({
  value,
  kind,
  symbol = '¥',
  className = '',
}: {
  value: number | string
  kind: TransactionKind
  symbol?: string
  className?: string
}) {
  return (
    <span className={`font-mono tabular-nums ${kindColorClass(kind)} ${className}`}>
      {formatSignedAmount(value, kind, symbol)}
    </span>
  )
}
