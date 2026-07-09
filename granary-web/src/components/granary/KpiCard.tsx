import { useCountUp } from '../../motion/useCountUp'
import { formatAmount } from '../../lib/format'

export function KpiCard({
  label,
  value,
  colorVar,
  sublabel,
  staggerIndex = 0,
  signed = false,
}: {
  label: string
  value: number
  colorVar: string
  sublabel: string
  staggerIndex?: number
  signed?: boolean
}) {
  const formatter = (n: number) => {
    const sign = signed && n > 0 ? '+' : n < 0 ? '-' : ''
    return `${sign}¥${formatAmount(n)}`
  }

  const ref = useCountUp(value, formatter, { delay: staggerIndex * 0.06 })

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
      <span
        ref={ref}
        className="font-num mt-1.5 block"
        style={{ fontSize: 20, fontWeight: 600, color: colorVar }}
      >
        ¥0.00
      </span>
      <div className="mt-1 text-[11px]" style={{ color: 'var(--g-ink-2)' }}>
        {sublabel}
      </div>
    </div>
  )
}
