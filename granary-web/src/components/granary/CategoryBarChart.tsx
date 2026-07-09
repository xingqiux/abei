import { useEffect, useRef } from 'react'
import gsap from 'gsap'
import { formatAmount } from '../../lib/format'
import { prefersReducedMotion } from '../../motion/reducedMotion'

export interface CategoryBarDatum {
  name: string
  value: number // 正数，已取绝对值
}

const PALETTE = [
  'var(--g-chart-1)',
  'var(--g-chart-2)',
  'var(--g-chart-3)',
  'var(--g-chart-4)',
  'var(--g-chart-5)',
  'var(--g-chart-6)',
]
const OTHER_COLOR = 'var(--g-chart-other)'

export function CategoryBarChart({ data }: { data: CategoryBarDatum[] }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const max = data.length > 0 ? Math.max(...data.map((d) => d.value)) : 0

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
        const pct = max > 0 ? (d.value / max) * 100 : 0
        const isOther = d.name === '其他'
        const color = isOther ? OTHER_COLOR : PALETTE[i % PALETTE.length]
        return (
          <div key={d.name} className="flex items-center gap-2">
            <div className="w-20 shrink-0 truncate text-[11.5px]" style={{ color: 'var(--g-ink-2)' }}>
              {d.name}
            </div>
            <div className="h-2 flex-1 overflow-hidden rounded-[3px]" style={{ background: 'var(--g-surface-2)' }}>
              <div
                data-bar
                data-target-width={`${pct}%`}
                className="h-full rounded-[3px]"
                style={{ width: 0, background: color }}
              />
            </div>
            <div className="font-num w-[84px] shrink-0 text-right text-[11.5px]" style={{ color: 'var(--g-ink)' }}>
              ¥{formatAmount(d.value)}
            </div>
          </div>
        )
      })}
    </div>
  )
}
