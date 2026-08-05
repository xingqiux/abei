import type { CSSProperties, ComponentType } from 'react'
import {
  ArrowPathIcon,
  CheckCircleIcon,
  EnvelopeIcon,
  ExclamationCircleIcon,
} from '@heroicons/react/24/outline'
import { prefersReducedMotion } from '../../motion/reducedMotion'

export type LottieIconKind = 'success' | 'loading' | 'error' | 'inbox'

type IconType = ComponentType<{ className?: string; style?: CSSProperties }>

const ICONS: Record<LottieIconKind, IconType> = {
  success: CheckCircleIcon,
  loading: ArrowPathIcon,
  error: ExclamationCircleIcon,
  inbox: EnvelopeIcon,
}

const DEFAULT_COLOR: Record<LottieIconKind, string> = {
  success: 'var(--done)',
  loading: 'var(--brand)',
  error: 'var(--danger)',
  inbox: 'var(--attention)',
}

export interface LottieIconProps {
  kind: LottieIconKind
  size?: number
  /** CSS 颜色值，留空按 kind 取语义色 */
  color?: string
  playing?: boolean
  className?: string
}

/**
 * 语义状态图标（成功/加载中/出错/收件箱），heroicons 静态图 + loading 的 CSS 旋转，不含 Lottie。
 * 名字是历史遗留，为省掉调用点改动没动。要播 Lottie 插画请用 `LottieArt`。
 */
export function LottieIcon({ kind, size = 20, color, playing = true, className }: LottieIconProps) {
  const Icon = ICONS[kind]
  const spinning = kind === 'loading' && playing && !prefersReducedMotion()
  return (
    <Icon
      aria-hidden
      className={[spinning ? 'animate-spin' : '', className].filter(Boolean).join(' ')}
      style={{ color: color ?? DEFAULT_COLOR[kind], width: size, height: size }}
    />
  )
}
