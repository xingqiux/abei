import { useEffect, useMemo, useRef, type ComponentType } from 'react'
import UseAnimationsImport from 'react-useanimations'
import lottie, { type AnimationItem } from 'lottie-web'
import checkmarkAnimImport from 'react-useanimations/lib/checkmark'
import loadingAnimImport from 'react-useanimations/lib/loading2'
import alertCircleAnimImport from 'react-useanimations/lib/alertCircle'
import mailAnimImport from 'react-useanimations/lib/mail'
import { prefersReducedMotion } from '../../motion/reducedMotion'

// react-useanimations 是纯 CJS 包；Vite 8 的 esbuild dep 预打包在 dev 模式下对它（以及它每个
// lib/* 子模块）的 `exports.default` 解包和生产构建（Rolldown）行为不一致：dev 下 `import X from
// '...'` 拿到的是 `{ __esModule: true, default: 真正的值 }` 这个模块对象本身，而不是它的 default。
// 这里做一次防御性拆包，两种情况都能拿到真正的值。
function unwrapDefault<T>(mod: T): T {
  const maybeWrapped = mod as unknown as { default?: T }
  return maybeWrapped?.default ?? mod
}

const UseAnimations = unwrapDefault(UseAnimationsImport) as ComponentType<any>
const checkmarkAnim = unwrapDefault(checkmarkAnimImport)
const loadingAnim = unwrapDefault(loadingAnimImport)
const alertCircleAnim = unwrapDefault(alertCircleAnimImport)
const mailAnim = unwrapDefault(mailAnimImport)

export type LottieIconKind = 'success' | 'loading' | 'error' | 'inbox'

// react-useanimations 自带的 lottie 动画数据；选它是因为已经内置了成品 JSON，
// 比手搓 lottie-web + 自寻素材实现更简单（"取实现简单者"）。
const ANIMATIONS = {
  success: checkmarkAnim,
  loading: loadingAnim,
  error: alertCircleAnim,
  inbox: mailAnim,
} satisfies Record<LottieIconKind, unknown>

// 加载态是唯一允许常驻循环播放的场景（空状态呼吸循环例外，见 EmptyState）。
const DEFAULT_LOOP: Record<LottieIconKind, boolean> = {
  success: false,
  loading: true,
  error: false,
  inbox: false,
}

// 未显式传 colorVar 时的默认语义色 token。
const DEFAULT_COLOR_VAR: Record<LottieIconKind, string> = {
  success: '--g-income',
  loading: '--g-accent',
  error: '--g-danger',
  inbox: '--g-warn',
}

export interface LottieIconProps {
  /** 内置动效名；传 'file' 并配合 src 从 src/assets/lottie/ 加载自定义 JSON */
  kind: LottieIconKind | 'file'
  /** kind='file' 时必填：JSON 资源的 URL（配合 Vite 的 `new URL(..., import.meta.url)` 或已 import 的路径） */
  src?: string
  size?: number
  /** CSS 变量名，如 '--g-income'；内部用 getComputedStyle 取实际颜色值传给 strokeColor */
  colorVar?: string
  /** 覆盖默认的循环行为 */
  loop?: boolean
  /** 是否播放；默认播放（reduce-motion 时强制为静态首帧，忽略此项） */
  playing?: boolean
  /** 播放速率（仅 file 模式），如 2 = 两倍速 */
  speed?: number
  /** file 模式播放完成回调（loop 时不会触发） */
  onComplete?: () => void
  className?: string
}

/** file 模式：直接用 lottie-web 播放自定义 JSON（react-useanimations 只内置了它自己那套动效） */
function LottieFilePlayer({
  src,
  size,
  loop,
  autoplay,
  speed,
  onComplete,
  className,
}: {
  src: string
  size: number
  loop: boolean
  autoplay: boolean
  speed?: number
  onComplete?: () => void
  className?: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let anim: AnimationItem | undefined
    let cancelled = false

    fetch(src)
      .then((res) => res.json())
      .then((animationData) => {
        if (cancelled || !containerRef.current) return
        anim = lottie.loadAnimation({
          container: containerRef.current,
          renderer: 'svg',
          loop,
          autoplay,
          animationData,
        })
        if (speed && speed !== 1) anim.setSpeed(speed)
        anim.addEventListener('complete', () => onCompleteRef.current?.())
      })
      .catch(() => {
        // 素材缺失时静默失败，留空白占位而不是抛错
      })

    return () => {
      cancelled = true
      anim?.destroy()
    }
  }, [src, loop, autoplay, speed])

  return <div ref={containerRef} className={className} style={{ width: size, height: size }} />
}

export function LottieIcon({ kind, src, size = 20, colorVar, loop, playing = true, speed, onComplete, className }: LottieIconProps) {
  const reduced = prefersReducedMotion()

  const builtinKind = kind === 'file' ? undefined : kind
  const strokeColor = useMemo(() => {
    if (typeof window === 'undefined' || !builtinKind) return undefined
    const varName = colorVar ?? DEFAULT_COLOR_VAR[builtinKind]
    const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
    return value || undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colorVar, builtinKind])

  const shouldLoop = (loop ?? (builtinKind ? DEFAULT_LOOP[builtinKind] : false)) && !reduced
  const shouldAutoplay = playing && !reduced

  if (kind === 'file') {
    if (!src) return null
    return (
      <LottieFilePlayer
        src={src}
        size={size}
        loop={shouldLoop}
        autoplay={shouldAutoplay}
        speed={speed}
        onComplete={onComplete}
        className={className}
      />
    )
  }

  return (
    <UseAnimations
      animation={ANIMATIONS[kind]}
      size={size}
      strokeColor={strokeColor}
      loop={shouldLoop}
      autoplay={shouldAutoplay}
      wrapperStyle={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
      className={className}
    />
  )
}
