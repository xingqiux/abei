import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { extent } from 'd3-array'
import { scaleLinear, scaleTime } from 'd3-scale'
import { area as d3Area, line as d3Line, curveMonotoneX } from 'd3-shape'
import gsap from 'gsap'
import type { BalanceSeries } from '../../lib/chartSeries'
import { formatAmount, formatMonthDay } from '../../lib/format'
import { prefersReducedMotion } from '../../motion/reducedMotion'

const PALETTE = [
  'var(--g-chart-1)',
  'var(--g-chart-2)',
  'var(--g-chart-3)',
  'var(--g-chart-4)',
  'var(--g-chart-5)',
  'var(--g-chart-6)',
]

const HEIGHT = 200
const PAD = { top: 12, right: 12, bottom: 28, left: 52 }

function parseLocalDate(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d)
}

function formatAxisMoney(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 10_000) return `${(n / 10_000).toFixed(1)}万`
  if (abs >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}

export function BalanceAreaChart({
  series,
  height = HEIGHT,
}: {
  series: BalanceSeries[]
  height?: number
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const clipUid = useId().replace(/:/g, '')
  const clipId = `balance-area-clip-${clipUid}`
  const [width, setWidth] = useState(640)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w && w > 0) setWidth(Math.floor(w))
    })
    ro.observe(el)
    setWidth(Math.floor(el.clientWidth) || 640)
    return () => ro.disconnect()
  }, [])

  const geometry = useMemo(() => {
    if (series.length === 0) return null

    const allPoints = series.flatMap((s) => s.points)
    if (allPoints.length === 0) return null

    const dates = allPoints.map((p) => parseLocalDate(p.date))
    const values = allPoints.map((p) => p.value)
    const [x0, x1] = extent(dates) as [Date, Date]
    let [y0, y1] = extent(values) as [number, number]

    // 给 y 轴一点余量；全 0 时给固定范围避免 scale 退化
    if (y0 === y1) {
      y0 = y0 - 1
      y1 = y1 + 1
    }
    const yPad = (y1 - y0) * 0.08
    y0 -= yPad
    y1 += yPad

    const innerW = Math.max(1, width - PAD.left - PAD.right)
    const innerH = Math.max(1, height - PAD.top - PAD.bottom)

    const xScale = scaleTime().domain([x0, x1]).range([0, innerW])
    const yScale = scaleLinear().domain([y0, y1]).range([innerH, 0])

    const lineGen = d3Line<{ date: string; value: number }>()
      .x((d) => xScale(parseLocalDate(d.date)))
      .y((d) => yScale(d.value))
      .curve(curveMonotoneX)

    // 面积基线：0 在域内则贴 0，否则贴 y 底；zeroInDomain 单独传出给虚线绘制
    const zeroInDomain = y0 <= 0 && y1 >= 0
    const baselineY = zeroInDomain ? yScale(0) : yScale(y0)
    const areaGen = d3Area<{ date: string; value: number }>()
      .x((d) => xScale(parseLocalDate(d.date)))
      .y0(baselineY)
      .y1((d) => yScale(d.value))
      .curve(curveMonotoneX)

    const paths = series.map((s, i) => ({
      key: s.key,
      name: s.name,
      color: PALETTE[i % PALETTE.length],
      line: lineGen(s.points) ?? '',
      area: areaGen(s.points) ?? '',
      last: s.points.at(-1)?.value ?? 0,
      symbol: s.currencySymbol,
    }))

    const xTicks = xScale.ticks(Math.min(5, Math.max(2, Math.floor(innerW / 90))))
    const yTicks = yScale.ticks(4)

    return { paths, xScale, yScale, xTicks, yTicks, innerW, innerH, baselineY, zeroInDomain }
  }, [series, width, height])

  // 入场：左→右 clip 揭示（规范 §6 图表生长 480ms）
  useEffect(() => {
    const svg = svgRef.current
    if (!svg || !geometry) return
    const reveal = svg.querySelector<SVGRectElement>('[data-reveal-rect]')
    if (!reveal) return

    const full = geometry.innerW
    if (prefersReducedMotion()) {
      reveal.setAttribute('width', String(full))
      return
    }

    reveal.setAttribute('width', '0')
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          gsap.to(reveal, {
            attr: { width: full },
            duration: 0.48,
            ease: 'power2.out',
          })
          observer.disconnect()
        }
      },
      { threshold: 0.2 },
    )
    observer.observe(svg)
    return () => {
      observer.disconnect()
      gsap.killTweensOf(reveal)
    }
  }, [geometry])

  if (!geometry) return null

  const { paths, xTicks, yTicks, innerW, innerH } = geometry

  return (
    <div ref={wrapRef} className="flex w-full flex-col gap-2.5">
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {paths.map((p) => (
          <div key={p.key} className="flex items-center gap-1.5 text-[11.5px]">
            <span
              className="inline-block h-1.5 w-3 shrink-0 rounded-[2px]"
              style={{ background: p.color }}
              aria-hidden
            />
            <span style={{ color: 'var(--g-ink-2)' }}>{p.name}</span>
            <span className="font-num" style={{ color: 'var(--g-ink)' }}>
              {p.symbol}
              {formatAmount(p.last)}
            </span>
          </div>
        ))}
      </div>

      <svg
        ref={svgRef}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="账户余额趋势"
        className="block max-w-full"
      >
        <defs>
          <clipPath id={clipId}>
            <rect data-reveal-rect x={0} y={0} width={0} height={innerH + 4} />
          </clipPath>
        </defs>

        <g transform={`translate(${PAD.left},${PAD.top})`}>
          {/* 网格 + Y 轴 */}
          {yTicks.map((t) => {
            const y = geometry.yScale(t)
            return (
              <g key={`y-${t}`}>
                <line
                  x1={0}
                  x2={innerW}
                  y1={y}
                  y2={y}
                  stroke="var(--g-border)"
                  strokeWidth={1}
                  strokeOpacity={0.7}
                />
                <text
                  x={-8}
                  y={y}
                  textAnchor="end"
                  dominantBaseline="middle"
                  fill="var(--g-ink-2)"
                  fontSize={10}
                  fontFamily="var(--g-font-num)"
                >
                  {formatAxisMoney(t)}
                </text>
              </g>
            )
          })}

          {/* X 轴 */}
          {xTicks.map((t) => {
            const x = geometry.xScale(t)
            const label = formatMonthDay(
              `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`,
            )
            return (
              <text
                key={`x-${t.getTime()}`}
                x={x}
                y={innerH + 16}
                textAnchor="middle"
                fill="var(--g-ink-2)"
                fontSize={10}
                fontFamily="var(--g-font-num)"
              >
                {label}
              </text>
            )
          })}

          {/* 仅当 0 真在 y 域内时画零虚线（避免全正数据在底边画假零线） */}
          {geometry.zeroInDomain && (
            <line
              x1={0}
              x2={innerW}
              y1={geometry.baselineY}
              y2={geometry.baselineY}
              stroke="var(--g-ink-2)"
              strokeWidth={1}
              strokeDasharray="3 3"
              strokeOpacity={0.45}
            />
          )}

          <g clipPath={`url(#${clipId})`}>
            {paths.map((p) => (
              <g key={p.key}>
                <path d={p.area} fill={p.color} fillOpacity={0.12} stroke="none" />
                <path
                  d={p.line}
                  fill="none"
                  stroke={p.color}
                  strokeWidth={1.75}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              </g>
            ))}
          </g>
        </g>
      </svg>
    </div>
  )
}
