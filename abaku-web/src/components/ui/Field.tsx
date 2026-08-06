import { createContext, useContext, useId } from 'react'
import type {
  InputHTMLAttributes,
  ReactNode,
  Ref,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'

/**
 * 表单控件。取自 tailwind-plus `forms/input-groups`：
 * 边框用 outline 而不是 border——因为 outline 不占盒模型，聚焦时从 1px 变 2px
 * 不会把布局顶动一格；`-outline-offset-1` 让它画在盒子内侧，视觉上等同 border。
 *
 * 项目里原先是一份手写的 `inputStyle` 内联对象，没有聚焦态也没有错误态。
 */
export const CONTROL_BASE =
  'block w-full rounded-md bg-[var(--surface-1)] text-[var(--text-primary)] ' +
  'outline-1 -outline-offset-1 outline-[var(--border-strong)] placeholder:text-[var(--text-tertiary)] ' +
  'focus:outline-2 focus:-outline-offset-2 focus:outline-[var(--focus-ring)] ' +
  'disabled:cursor-not-allowed disabled:opacity-50'

const CONTROL = `${CONTROL_BASE} px-3 py-1.5 text-sm`

/**
 * 给没有可见 label 的裸控件用（筛选条那种一行摆七八个、靠 aria-label 说明的）。
 * 关键是它带聚焦态——页面里原先这类控件一律 `outline-none` 且没有替代，
 * 键盘 Tab 过去完全看不出焦点在哪。
 */
export const CONTROL_COMPACT = `${CONTROL_BASE} px-2 py-1.5 text-xs`

export const CONTROL_INVALID = 'outline-[var(--danger)] focus:outline-[var(--danger)]'

interface FieldContextValue {
  id?: string
  describedBy?: string
  invalid: boolean
}

/** 空默认值：控件不套 Field 单独用时也能工作，只是拿不到 id 关联 */
const FieldContext = createContext<FieldContextValue>({ invalid: false })

/**
 * 让非原生控件也能接上 Field 的 label / 错误提示。
 * Combobox 这种自绘控件不是 input/select/textarea，拿不到下面那几个包装组件，
 * 但同样需要 htmlFor 指向的那个 id，否则 label 点了不聚焦、读屏也读不到字段名。
 */
export function useFieldControl(): FieldContextValue {
  return useContext(FieldContext)
}

interface FieldProps {
  label: string
  children: ReactNode
  /** 说明文字，挂在控件下方 */
  hint?: string
  /** 有值就显示为错误态，并被 aria-describedby 引用 */
  error?: string
  /** 隐藏视觉标签但保留给读屏 */
  srOnlyLabel?: boolean
}

/**
 * label + 控件 + 说明/错误。用 useId 串起 htmlFor / aria-describedby，
 * 调用方不用自己编 id。控件通过 children 传入，Field 只负责包壳。
 */
export function Field({ label, children, hint, error, srOnlyLabel = false }: FieldProps) {
  const id = useId()
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined
  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={id}
        className={srOnlyLabel ? 'sr-only' : 'text-sm/6 font-medium text-[var(--text-primary)]'}
      >
        {label}
      </label>
      <FieldContext.Provider value={{ id, describedBy, invalid: error != null }}>
        {children}
      </FieldContext.Provider>
      {error ? (
        <p id={`${id}-error`} className="text-xs text-[var(--danger)]">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-[var(--text-tertiary)]">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

export function Input({
  className = '',
  ref,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  const field = useContext(FieldContext)
  return (
    <input
      ref={ref}
      id={field.id}
      aria-describedby={field.describedBy}
      aria-invalid={field.invalid || undefined}
      className={`${CONTROL} ${field.invalid ? CONTROL_INVALID : ''} ${className}`}
      {...rest}
    />
  )
}

export function Textarea({ className = '', ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const field = useContext(FieldContext)
  return (
    <textarea
      id={field.id}
      aria-describedby={field.describedBy}
      aria-invalid={field.invalid || undefined}
      className={`${CONTROL} ${field.invalid ? CONTROL_INVALID : ''} ${className}`}
      {...rest}
    />
  )
}

export function Select({ className = '', ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  const field = useContext(FieldContext)
  return (
    <select
      id={field.id}
      aria-describedby={field.describedBy}
      aria-invalid={field.invalid || undefined}
      className={`${CONTROL} ${field.invalid ? CONTROL_INVALID : ''} pr-8 ${className}`}
      {...rest}
    />
  )
}
