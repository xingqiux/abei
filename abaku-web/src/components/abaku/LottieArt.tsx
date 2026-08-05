import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AnimationItem } from 'lottie-web'
import { prefersReducedMotion } from '../../motion/reducedMotion'

export interface LottieArtProps {
  /**
   * Lottie JSON 的地址，从 `src/assets/lottie` 的 `lottieArt` 表里取（那张表用 `?url` 导入）。
   * 不要直接 `import data from './x.json'`，那样 JSON 会被打进 JS 包。
   */
  src: string
  /**
   * 容器尺寸必须在这里给死（如 `size-28`、`h-[70vh] w-[70vw]`）。
   * lottie 渲染出来的 svg 是容器的 100%，容器没尺寸就什么都看不见。
   */
  className?: string
  loop?: boolean
  /**
   * 收场回调，最多触发一次，语义是「这儿没有更多东西要放了」。三种情况都会触发：
   * 播完一遍（`loop=false`）、reduced-motion 不播、素材或播放器加载失败。
   */
  onComplete?: () => void
  /** 不播时（reduced-motion / 加载失败）顶上的静态替身。不给就留空。 */
  fallback?: ReactNode
}

/**
 * 播放一个 Lottie JSON 插画。装饰性元素，`aria-hidden`，不承载信息。
 *
 * 播放器走动态 import，只有真正要播的时候才下载，不进主 chunk。
 * 用的是 `lottie_light`（只带 svg renderer、不带表达式引擎）而不是完整版，两个理由：
 * 完整版靠直接 `eval` 跑 Lottie 表达式，而 nginx.conf 的 CSP 是 `script-src 'self'`，
 * 没有 `unsafe-eval`，那句 eval 在生产会直接抛错把动画搞挂；顺带压缩后从 ~300KB 降到 ~165KB。
 * 代价是 empty-wallet 里那一条回弹表达式不生效，退回它自己的关键帧，观感差别很小。
 *
 * 语义状态图标请用 `LottieIcon`，那是另一件事。
 */
export function LottieArt({ src, className, loop = true, onComplete, fallback }: LottieArtProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const onCompleteRef = useRef(onComplete)
  const firedRef = useRef(false)
  const [playable, setPlayable] = useState(() => !prefersReducedMotion())

  useEffect(() => {
    onCompleteRef.current = onComplete
  }, [onComplete])

  useEffect(() => {
    firedRef.current = false
    const fireOnce = () => {
      if (firedRef.current) return
      firedRef.current = true
      onCompleteRef.current?.()
    }

    // reduced-motion 下不播，并且连播放器那个 chunk 都不去下载：
    // 为了画一帧静止画面就拉一个 ~165KB 的播放器，对明确要求少动效的用户是纯浪费，
    // 静态替身（fallback）传达的信息完全一样。
    if (prefersReducedMotion()) {
      setPlayable(false)
      fireOnce()
      return
    }

    let disposed = false
    let anim: AnimationItem | undefined

    const giveUp = () => {
      if (disposed) return
      setPlayable(false)
      fireOnce()
    }

    void (async () => {
      try {
        const { default: lottie } = await import('lottie-web/build/player/lottie_light')
        if (disposed || !hostRef.current) return
        anim = lottie.loadAnimation({
          container: hostRef.current,
          renderer: 'svg',
          loop,
          autoplay: true,
          path: src,
          rendererSettings: { preserveAspectRatio: 'xMidYMid meet' },
        })
        // 素材 404 / JSON 坏了 / 渲染报错：静默留空，不抛错也不显示破图。
        anim.addEventListener('data_failed', giveUp)
        anim.addEventListener('error', giveUp)
        if (!loop) {
          anim.addEventListener('complete', () => {
            if (!disposed) fireOnce()
          })
        }
      } catch {
        // 播放器 chunk 本身没加载出来（离线、构建产物缺失）。
        giveUp()
      }
    })()

    return () => {
      disposed = true
      anim?.destroy()
      anim = undefined
    }
  }, [src, loop])

  return (
    <div aria-hidden className={className}>
      {playable ? <div ref={hostRef} className="h-full w-full" /> : fallback}
    </div>
  )
}
