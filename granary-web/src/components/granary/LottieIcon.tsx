import { CircleAlert, CircleCheck, LoaderCircle, Mail, type LucideIcon } from 'lucide-react'
import { prefersReducedMotion } from '../../motion/reducedMotion'

export type LottieIconKind = 'success' | 'loading' | 'error' | 'inbox'

const ICONS: Record<LottieIconKind, LucideIcon> = {
  success: CircleCheck,
  loading: LoaderCircle,
  error: CircleAlert,
  inbox: Mail,
}

const DEFAULT_COLOR_VAR: Record<LottieIconKind, string> = {
  success: '--g-income',
  loading: '--g-accent',
  error: '--g-danger',
  inbox: '--g-warn',
}

export interface LottieIconProps {
  kind: LottieIconKind
  size?: number
  colorVar?: string
  playing?: boolean
  className?: string
}

/** Semantic status icon. The legacy component name is kept to avoid churn at call sites. */
export function LottieIcon({ kind, size = 20, colorVar, playing = true, className }: LottieIconProps) {
  const Icon = ICONS[kind]
  const spinning = kind === 'loading' && playing && !prefersReducedMotion()
  return (
    <Icon
      aria-hidden
      size={size}
      className={[spinning ? 'animate-spin' : '', className].filter(Boolean).join(' ')}
      style={{ color: `var(${colorVar ?? DEFAULT_COLOR_VAR[kind]})` }}
    />
  )
}
