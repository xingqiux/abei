import { useEffect, useRef } from 'react'
import { CakeIcon } from '@heroicons/react/24/outline'
import { playGrainBurst } from '../../motion/grainBurst'
import { prefersReducedMotion } from '../../motion/reducedMotion'

/**
 * 全屏庆祝动效（对账清零 / 储蓄达成等里程碑时刻）。
 * 播放一次即回调 onDone 卸载；粒子效果由按需加载的 matter.js 提供。
 */
export function CelebrateOverlay({ onDone }: { onDone: () => void }) {
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (overlayRef.current) {
      void playGrainBurst(overlayRef.current, { count: 60 })
    }
    const timer = window.setTimeout(onDone, prefersReducedMotion() ? 0 : 1800)
    return () => window.clearTimeout(timer)
  }, [onDone])

  return (
    <div ref={overlayRef} className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center overflow-hidden">
      <CakeIcon aria-hidden className="size-16 animate-pulse" style={{ color: 'var(--g-accent)' }} />
    </div>
  )
}
