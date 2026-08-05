import { formatAmount } from '../../lib/format'
import type { CurrencyAmount } from '../../lib/summary'

export function KpiCard({
  label,
  amounts,
  colorVar,
  sublabel,
  signed = false,
}: {
  label: string
  amounts: CurrencyAmount[]
  colorVar: string
  sublabel: string
  signed?: boolean
}) {
  return (
    <div
      className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-gray-200 dark:bg-gray-900 dark:ring-gray-700"
    >
      <div
        className="text-[11px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400"
      >
        {label}
      </div>
      <div className="font-num mt-1.5 flex min-h-[30px] flex-wrap items-baseline gap-x-3 gap-y-1" style={{ color: colorVar }}>
        {amounts.map((amount) => {
          const negative = amount.value.trim().startsWith('-')
          const zero = /^[-+]?0(?:\.0*)?$/.test(amount.value.trim())
          const sign = signed && !zero ? (negative ? '-' : '+') : negative ? '-' : ''
          return (
            <span key={amount.code} title={amount.code} style={{ fontSize: 20, fontWeight: 600 }}>
              {sign}{amount.symbol}{formatAmount(amount.value)}
            </span>
          )
        })}
        {amounts.length === 0 && <span style={{ fontSize: 20, fontWeight: 600 }}>--</span>}
      </div>
      <div className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
        {sublabel}
      </div>
    </div>
  )
}
