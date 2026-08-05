import { useLayoutEffect, useRef, type ReactNode } from 'react'
import gsap from 'gsap'
import { prefersReducedMotion } from '../../motion/reducedMotion'

/**
 * 包裹每个路由页面内容；挂载时 fade-in 12px ↑，240ms。
 * 父组件需在切路由时改变 key 让本组件重新挂载才能触发过渡。
 */
export function PageTransition({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (prefersReducedMotion()) return

    gsap.fromTo(
      el,
      { opacity: 0, y: 12 },
      { opacity: 1, y: 0, duration: 0.24, ease: 'power3.out' },
    )
  }, [])

  return <div ref={ref}>{children}</div>
}
