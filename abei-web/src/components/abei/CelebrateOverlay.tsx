import { useCallback, useEffect, useRef } from 'react'
import { lottieArt } from '../../assets/lottie'
import { LottieArt } from './LottieArt'

/** celebrate.json 全长 5s，兜底定时器留一点余量。 */
const FALLBACK_MS = 6000

/**
 * 全屏庆祝动效（对账清零等里程碑时刻）：淡入一层遮罩，播一遍 celebrate.json，播完回调 onDone。
 * reduced-motion 或素材加载失败时不播，立刻收场。
 */
export function CelebrateOverlay({ onDone }: { onDone: () => void }) {
  const onDoneRef = useRef(onDone)
  const doneRef = useRef(false)

  useEffect(() => {
    onDoneRef.current = onDone
  }, [onDone])

  const finish = useCallback(() => {
    if (doneRef.current) return
    doneRef.current = true
    onDoneRef.current()
  }, [])

  useEffect(() => {
    // 兜底：万一 complete 事件没到（网络挂住、播放器 chunk 慢），遮罩也得自己收场。
    const timer = window.setTimeout(finish, FALLBACK_MS)
    return () => window.clearTimeout(timer)
  }, [finish])

  return (
    <div
      className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-[var(--surface-0)]/70"
      style={{ animation: 'g-celebrate-fade 0.3s ease-out' }}
    >
      <LottieArt
        src={lottieArt.celebrate}
        className="h-[70vh] max-h-[560px] w-[80vw] max-w-[420px]"
        loop={false}
        onComplete={finish}
      />
    </div>
  )
}
