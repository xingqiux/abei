import { useEffect, useRef } from 'react'
import gsap from 'gsap'
import { formatAmount } from '../../lib/format'
import { prefersReducedMotion } from '../../motion/reducedMotion'
import { compareDecimalStrings, decimalPercentage } from '../../lib/decimal'

export interface CategoryBarDatum {
  name: string
  value: string
  currencyCode: string
}

/** 图表分类色板，不带语义。见 BalanceAreaChart 里的说明 */
const PALETTE = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-6)',
]
const OTHER_COLOR = 'var(--border-strong)'

export function CategoryBarChart({ data }: { data: CategoryBarDatum[] }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const maxByCurrency = new Map<string, string>()
  for (const datum of data) {
    const current = maxByCurrency.get(datum.currencyCode)
    if (!current || compareDecimalStrings(datum.value, current) > 0) maxByCurrency.set(datum.currencyCode, datum.value)
  }

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const bars = Array.from(container.querySelectorAll<HTMLElement>('[data-bar]'))
    if (bars.length === 0) return

    if (prefersReducedMotion()) {
      bars.forEach((bar) => {
        bar.style.width = bar.dataset.targetWidth ?? '0%'
      })
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return
          const el = entry.target as HTMLElement
          gsap.fromTo(
            el,
            { width: '0%' },
            { width: el.dataset.targetWidth ?? '0%', duration: 0.48, ease: 'power2.out' },
          )
          observer.unobserve(el)
        })
      },
      { threshold: 0.2 },
    )
    bars.forEach((bar) => observer.observe(bar))
    return () => observer.disconnect()
  }, [data])

  return (
    <div ref={containerRef} className="flex flex-col gap-2.5">
      {data.map((d, i) => {
        const max = maxByCurrency.get(d.currencyCode) ?? '0'
        const pct = decimalPercentage(d.value, max)
        const isOther = d.name === '其他'
        const color = isOther ? OTHER_COLOR : PALETTE[i % PALETTE.length]
        return (
          <div key={`${d.currencyCode}-${d.name}`} className="flex items-center gap-2">
            <div className="w-20 shrink-0 truncate text-[11.5px] text-[var(--text-secondary)] ">
              {d.name}
            </div>
            <div className="h-2 flex-1 overflow-hidden rounded-[3px] bg-[var(--surface-hover)] ">
              <div
                data-bar
                data-target-width={`${pct}%`}
                className="h-full rounded-[3px]"
                style={{ width: 0, background: color }}
              />
            </div>
            <div className="num w-[84px] shrink-0 text-right text-[11.5px] text-[var(--text-primary)] ">
              {d.currencyCode} {formatAmount(d.value)}
            </div>
          </div>
        )
      })}
    </div>
  )
}
