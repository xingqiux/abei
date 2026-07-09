import { useEffect, useRef } from 'react'
import gsap from 'gsap'
import Lenis from 'lenis'
import { prefersReducedMotion } from './reducedMotion'

declare global {
  interface Window {
    __lenis?: Lenis
  }
}

/**
 * 阅读型长页专用的平滑滚动（规范 §6：只挂 /reports、/settings；交易列表/收件箱/对账
 * 等操作型页面禁用，避免与虚拟滚动、j/k 键盘走行冲突）。
 *
 * 用法：把返回的 ref 挂在页面根节点上；hook 内部沿 DOM 树向上找最近的可滚动容器
 * （AppShell 里的 `<main class="overflow-y-auto">`）作为 Lenis 的 wrapper。
 * raf 循环复用项目已有的 gsap.ticker，避免和其他动效各起一个 requestAnimationFrame。
 * 卸载时（切路由）destroy 实例；prefers-reduced-motion 时整个不创建。
 */
export function useLenis<T extends HTMLElement>() {
  const ref = useRef<T>(null)

  useEffect(() => {
    if (prefersReducedMotion()) return
    const el = ref.current
    const wrapper = el?.closest('main') as HTMLElement | null
    if (!wrapper) return
    const content = (wrapper.firstElementChild as HTMLElement | null) ?? wrapper

    const lenis = new Lenis({
      wrapper,
      content,
      smoothWheel: true,
    })
    window.__lenis = lenis

    function raf(time: number) {
      // gsap.ticker 的 time 单位是秒，lenis.raf 需要毫秒
      lenis.raf(time * 1000)
    }
    gsap.ticker.add(raf)
    gsap.ticker.lagSmoothing(0)

    return () => {
      gsap.ticker.remove(raf)
      lenis.destroy()
      if (window.__lenis === lenis) delete window.__lenis
    }
  }, [])

  return ref
}
