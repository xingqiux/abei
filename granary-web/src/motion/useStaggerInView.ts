import { useEffect, useRef } from 'react'
import gsap from 'gsap'
import { prefersReducedMotion } from './reducedMotion'

/**
 * 容器内直接子元素的入场 stagger 淡入，但用 IntersectionObserver 触发——只有容器
 * 进入视口才播放，且只播放一次（哪怕之后滚出视口再滚回来也不重播）。
 * 用于对账页日历带这类格子数量较多、不保证首屏可见的场景（规范 §6 补漏项）。
 */
export function useStaggerInView<T extends HTMLElement>(
  deps: readonly unknown[],
  opts: { stagger?: number; distance?: number; duration?: number } = {},
) {
  const ref = useRef<T>(null)
  const playedRef = useRef(false)
  const { stagger = 0.02, distance = 8, duration = 0.22 } = opts

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const children = Array.from(el.children) as HTMLElement[]
    if (children.length === 0) return

    if (prefersReducedMotion() || playedRef.current) {
      children.forEach((c) => {
        c.style.opacity = '1'
        c.style.transform = 'none'
      })
      return
    }

    children.forEach((c) => {
      c.style.opacity = '0'
      c.style.transform = `translateY(${distance}px)`
    })

    const observer = new IntersectionObserver(
      (entries) => {
        if (playedRef.current) return
        if (!entries[0]?.isIntersecting) return
        playedRef.current = true
        gsap.to(children, { opacity: 1, y: 0, duration, stagger, ease: 'power2.out' })
        observer.disconnect()
      },
      { threshold: 0.1 },
    )
    observer.observe(el)

    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return ref
}
