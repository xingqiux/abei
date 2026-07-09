import { formatSignedAmount, kindColorVar, type TransactionKind } from '../../lib/format'

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
    <span className={`font-num ${className}`} style={{ color: kindColorVar(kind) }}>
      {formatSignedAmount(value, kind, symbol)}
    </span>
  )
}
