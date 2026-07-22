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
      className="rounded-[10px] p-3.5"
      style={{ background: 'var(--g-surface)', boxShadow: 'var(--g-shadow)' }}
    >
      <div
        className="text-[11px]"
        style={{ color: 'var(--g-ink-2)', letterSpacing: '.04em', textTransform: 'uppercase' }}
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
      <div className="mt-1 text-[11px]" style={{ color: 'var(--g-ink-2)' }}>
        {sublabel}
      </div>
    </div>
  )
}
