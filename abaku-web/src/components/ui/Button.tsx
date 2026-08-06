import type { ButtonHTMLAttributes, ReactNode } from 'react'

/**
 * 按钮。几何与状态照抄 tailwind-plus `elements/buttons`
 * （primary / secondary / soft 三份），颜色换成本项目的 token。
 *
 * 关键差别：tailwind-plus 用 `dark:` 前缀写两套类名，我们走 CSS 变量，
 * 所以同一串类名在深浅两个主题下自动成立，不用写两遍、也不会漏掉一遍。
 * 「浅色投影 / 深色发丝线」这条也是 token 化的（--shadow-card / --ring-card），
 * 两个属性一起挂，任一主题下永远只有一个是可见的。
 */
export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'soft'
  | 'danger'
  /** 破坏性操作的文字按钮：不占实心底，但颜色明确是「会删东西」 */
  | 'ghost-danger'
export type ButtonSize = 'xs' | 'sm' | 'md'

const SIZES: Record<ButtonSize, string> = {
  xs: 'gap-1 px-2 py-1 text-xs',
  sm: 'gap-1.5 px-2.5 py-1.5 text-sm',
  md: 'gap-1.5 px-3 py-2 text-sm',
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--brand)] text-[var(--brand-on)] shadow-[var(--shadow-card)] hover:bg-[var(--brand-hover)]',
  secondary:
    'bg-[var(--surface-1)] text-[var(--text-primary)] shadow-[var(--shadow-card)] ring-1 ring-inset ring-[var(--border-strong)] hover:bg-[var(--surface-hover)]',
  ghost:
    'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
  soft: 'bg-[var(--brand-soft)] text-[var(--brand-text)] hover:bg-[var(--surface-selected)]',
  danger:
    'bg-[var(--danger)] text-[var(--brand-on)] shadow-[var(--shadow-card)] hover:bg-[var(--danger-hover)]',
  'ghost-danger': 'text-[var(--danger)] hover:bg-[var(--danger-soft)]',
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** 撑满一行，用于对话框底部和移动端 */
  block?: boolean
}

export function Button({
  variant = 'secondary',
  size = 'sm',
  block = false,
  className = '',
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center rounded-md font-semibold whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50 ${SIZES[size]} ${VARIANTS[variant]} ${block ? 'w-full' : ''} ${className}`}
      {...rest}
    />
  )
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 图标按钮没有可见文字，label 同时当 aria-label 和 tooltip */
  label: string
  children: ReactNode
  variant?: Extract<ButtonVariant, 'ghost' | 'secondary' | 'soft' | 'ghost-danger'>
}

export function IconButton({
  label,
  variant = 'ghost',
  className = '',
  type = 'button',
  children,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={`inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors disabled:pointer-events-none disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}
