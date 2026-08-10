import { useEffect, useRef } from 'react'
import gsap from 'gsap'
import { prefersReducedMotion } from '../../motion/reducedMotion'

export interface DonutSegment {
  key: string
  label: string
  /** 已取绝对值的数值；<=0 的段直接不画 */
  value: number
  /** CSS 颜色（应当是 var(--chart-N) 这类 token） */
  color: string
}

/**
 * 环形占比图。circle 描边 + strokeDasharray 实现，不引 d3-shape 的 arc——
 * 段数少（资产/负债这类 2~4 段）时描边写法最短，且 dashoffset 可以直接 tween。
 * 中心文案由调用方传入，图本身不做图例；数值语义（正负号、币种）也归调用方。
 */
export function DonutChart({
  segments,
  centerLabel,
  centerValue,
  size = 168,
  thickness = 20,
  ariaLabel,
}: {
  segments: DonutSegment[]
  centerLabel?: string
  centerValue?: string
  size?: number
  thickness?: number
  ariaLabel: string
}) {
  const groupRef = useRef<SVGGElement>(null)
  const visible = segments.filter((segment) => segment.value > 0)
  const total = visible.reduce((sum, segment) => sum + segment.value, 0)
  const signature = segments.map((segment) => `${segment.key}:${segment.value}`).join('|')

  // 入场：整环从 12 点方向顺时针长出来（fromTo 一次搞定，方便测试环境 mock）
  useEffect(() => {
    const group = groupRef.current
    if (!group || prefersReducedMotion()) return
    const circles = Array.from(group.querySelectorAll<SVGCircleElement>('[data-donut-seg]'))
    for (const circle of circles) {
      // dasharray 是 [段长, 整圈]：offset = 段长时整段藏起，tween 到 0 就是从头长出来
      gsap.fromTo(
        circle,
        { strokeDashoffset: Number(circle.dataset.length ?? 0) },
        { strokeDashoffset: 0, duration: 0.6, ease: 'power2.out' },
      )
    }
    return () => {
      for (const circle of circles) gsap.killTweensOf(circle)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])

  if (total <= 0) return null

  const radius = (size - thickness) / 2
  const circumference = 2 * Math.PI * radius
  const gap = visible.length > 1 ? 2 : 0 // 段间留一道细缝，颜色相邻时不糊

  let offsetSoFar = 0
  const arcs = visible.map((segment) => {
    const length = Math.max(0, (segment.value / total) * circumference - gap)
    const arc = { ...segment, length, rotation: (offsetSoFar / circumference) * 360 }
    offsetSoFar += (segment.value / total) * circumference
    return arc
  })

  return (
    <div className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={ariaLabel}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--surface-hover)"
          strokeWidth={thickness}
        />
        <g ref={groupRef} transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          {arcs.map((arc) => (
            <circle
              key={arc.key}
              data-donut-seg
              data-length={arc.length}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={arc.color}
              strokeWidth={thickness}
              strokeLinecap={gap > 0 ? 'round' : 'butt'}
              strokeDasharray={`${arc.length} ${circumference}`}
              transform={`rotate(${arc.rotation} ${size / 2} ${size / 2})`}
            />
          ))}
        </g>
      </svg>
      {(centerLabel || centerValue) && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-0.5 text-center">
          {centerLabel && <span className="text-[11px] text-[var(--text-secondary)]">{centerLabel}</span>}
          {centerValue && (
            <span className="num max-w-[70%] truncate text-[15px] font-semibold text-[var(--text-primary)]">{centerValue}</span>
          )}
        </div>
      )}
    </div>
  )
}
