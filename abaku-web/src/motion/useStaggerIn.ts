import { useLayoutEffect, useRef } from 'react'
import gsap from 'gsap'
import { prefersReducedMotion } from './reducedMotion'

/**
 * 容器内直接子元素做入场 stagger：前 `limit` 个上移 12px 淡入，delay 递增，
 * 其余（超过 limit 的）直接显示。依赖 `deps` 变化时重新播放（例如翻页/切 tab 不触发，
 * 只在 deps 里放"首次加载完成"标志）。
 */
export function useStaggerIn<T extends HTMLElement>(
  deps: readonly unknown[],
  opts: { limit?: number; stagger?: number; distance?: number; duration?: number } = {},
) {
  const ref = useRef<T>(null)
  const { limit = 12, stagger = 0.024, distance = 12, duration = 0.24 } = opts

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const children = Array.from(el.children) as HTMLElement[]
    if (children.length === 0) return

    if (prefersReducedMotion()) {
      children.forEach((c) => {
        c.style.opacity = '1'
        c.style.transform = 'none'
      })
      return
    }

    const animated = children.slice(0, limit)
    const rest = children.slice(limit)
    rest.forEach((c) => {
      c.style.opacity = '1'
      c.style.transform = 'none'
    })

    gsap.fromTo(
      animated,
      { opacity: 0, y: distance },
      { opacity: 1, y: 0, duration, stagger, ease: 'power2.out' },
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return ref
}
