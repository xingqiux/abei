import { useEffect, useRef } from 'react'
import gsap from 'gsap'
import { prefersReducedMotion } from './reducedMotion'

/**
 * 数字从 0 滚动到 value，expo-out，可配合 delay 做 stagger。
 * 绑定在一个 <span ref> 上，内部直接写 textContent（格式化交给 formatter）。
 */
export function useCountUp(value: number, formatter: (n: number) => string, opts: { delay?: number; duration?: number } = {}) {
  const ref = useRef<HTMLSpanElement>(null)
  const { delay = 0, duration = 0.8 } = opts

  useEffect(() => {
    const el = ref.current
    if (!el) return

    if (prefersReducedMotion()) {
      el.textContent = formatter(value)
      return
    }

    const obj = { n: 0 }
    const tween = gsap.to(obj, {
      n: value,
      duration,
      delay,
      ease: 'expo.out',
      onUpdate: () => {
        el.textContent = formatter(obj.n)
      },
    })
    return () => {
      tween.kill()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, delay, duration])

  return ref
}
