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
  success: 'light-dark(var(--color-emerald-600), var(--color-emerald-400))',
  loading: 'light-dark(var(--color-indigo-600), var(--color-indigo-500))',
  error: 'light-dark(var(--color-red-600), var(--color-red-400))',
  inbox: 'light-dark(var(--color-amber-600), var(--color-amber-400))',
}

export interface LottieIconProps {
  kind: LottieIconKind
  size?: number
  /** CSS 颜色值，留空按 kind 取语义色 */
  color?: string
  playing?: boolean
  className?: string
}

/** Semantic status icon. The legacy component name is kept to avoid churn at call sites. */
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
