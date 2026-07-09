import { useRef } from 'react'
import { LottieIcon, type LottieIconKind } from './LottieIcon'
import { playGrainBurst } from '../../motion/grainBurst'

export function EmptyState({
  icon = '🌾',
  lottie,
  lottieSrc,
  message,
  actionLabel,
  onAction,
}: {
  icon?: string
  /** 传入后用内置 Lottie 动效替代 emoji（如 inbox/loading） */
  lottie?: LottieIconKind
  /** 自定义 Lottie JSON 的 URL（优先级高于 lottie），空状态呼吸循环 */
  lottieSrc?: string
  message: string
  actionLabel?: string
  onAction?: () => void
}) {
  const cardRef = useRef<HTMLDivElement>(null)

  // 空状态彩蛋（规范 §6 场景①）：点一下钱袋，容器内撒一把小规模谷粒；纯彩蛋不加文案。
  const handleEasterEgg = () => {
    if (!lottieSrc || !cardRef.current) return
    void playGrainBurst(cardRef.current, { count: 25 })
  }

  return (
    <div
      ref={cardRef}
      className="relative flex flex-col items-center justify-center gap-3 py-16 text-center"
      style={lottieSrc ? { overflow: 'hidden' } : undefined}
    >
      {lottieSrc ? (
        <div onClick={handleEasterEgg} title="🌾" style={{ cursor: 'pointer' }}>
          <LottieIcon kind="file" src={lottieSrc} size={72} loop />
        </div>
      ) : lottie ? (
        <LottieIcon kind={lottie} size={40} loop={lottie === 'loading' || lottie === 'inbox'} />
      ) : (
        <div style={{ fontSize: 32 }} aria-hidden>
          {icon}
        </div>
      )}
      <div style={{ color: 'var(--g-ink-2)', fontSize: 13 }}>{message}</div>
      {actionLabel && (
        <button
          type="button"
          onClick={onAction}
          className="rounded-[6px] px-3 py-1.5 text-[12.5px]"
          style={{ background: 'var(--g-accent)', color: 'var(--g-accent-ink)', fontWeight: 'var(--g-weight-demibold)' }}
        >
          {actionLabel}
        </button>
      )}
    </div>
  )
}
