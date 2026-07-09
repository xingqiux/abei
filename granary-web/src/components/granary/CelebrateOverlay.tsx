import { useEffect, useRef } from 'react'
import { LottieIcon } from './LottieIcon'
import celebrateUrl from '../../assets/lottie/celebrate.json?url'
import { playGrainBurst } from '../../motion/grainBurst'

/**
 * 全屏庆祝动效（对账清零 / 储蓄达成等里程碑时刻）。
 * 播放一次即回调 onDone 卸载；2 倍速把 5s 素材压到 ~2.5s，贴近规范的 ≤2s 要求。
 * 彩纸 Lottie 播放的同时叠加一次 matter.js 谷粒撒落（规范 §6 里程碑庆祝场景②）。
 */
export function CelebrateOverlay({ onDone }: { onDone: () => void }) {
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (overlayRef.current) {
      void playGrainBurst(overlayRef.current, { count: 60 })
    }
  }, [])

  return (
    <div ref={overlayRef} className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center overflow-hidden">
      <LottieIcon kind="file" src={celebrateUrl} size={420} speed={2} onComplete={onDone} />
    </div>
  )
}
