import { Radio, RadioGroup } from '@headlessui/react'

/**
 * 分段选择器。样式取自 tailwind-plus `navigation/tabs/tabs-in-pills-with-brand-color`，
 * 语义用 headlessui `RadioGroup`。
 *
 * 为什么不是 tablist：这几处（支出/收入/转账、单笔/多拆分）是在选一个**值**，
 * 不是在切换若干块并列内容。radiogroup 读屏会播「3 选 1，当前第 2 项」，
 * tablist 不会。之前手写的那几处挂了 role="tab" 却没有面板，
 * 而且方向键完全不响应——一组按钮而已。
 */
export interface SegmentDef<T extends string> {
  value: T
  label: string
}

export function SegmentedControl<T extends string>({
  segments,
  value,
  onChange,
  'aria-label': ariaLabel,
  className = '',
}: {
  segments: readonly SegmentDef<T>[]
  value: T
  onChange: (value: T) => void
  'aria-label': string
  className?: string
}) {
  return (
    <RadioGroup
      value={value}
      onChange={onChange}
      aria-label={ariaLabel}
      className={`flex gap-0.5 rounded-lg bg-[var(--surface-hover)] p-0.5 ${className}`}
    >
      {segments.map((segment) => (
        <Radio
          key={segment.value}
          value={segment.value}
          className="flex-1 cursor-pointer rounded-md px-3 py-1.5 text-center text-sm font-medium whitespace-nowrap text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] data-checked:bg-[var(--brand)] data-checked:font-semibold data-checked:text-[var(--brand-on)]"
        >
          {segment.label}
        </Radio>
      ))}
    </RadioGroup>
  )
}
