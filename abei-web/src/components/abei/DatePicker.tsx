import { useState } from 'react'
import { CalendarDots, CaretLeft, CaretRight } from '@phosphor-icons/react'
import { Popover, PopoverButton, PopoverPanel } from '@headlessui/react'
import { isValidIsoDate } from '../../lib/dateRange'
import { addMonths, formatDateLabel, toDateInputValue } from '../../lib/format'
import { CONTROL_BASE, CONTROL_INVALID, useFieldControl } from '../ui/Field'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

/** 解析 "YYYY-MM-DD" 为本地日期；无效值回落到今天，日历总得有个落脚点 */
function parseOrToday(iso: string): Date {
  if (!isValidIsoDate(iso)) return new Date()
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/**
 * 某个月的日历格子。补齐到整周，前后两头用上/下个月的日子填，
 * 这样格子数固定、不会因为月份换了就跳一行高度。
 */
function monthGrid(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const start = new Date(first)
  start.setDate(first.getDate() - first.getDay())
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    return d
  })
}

export interface DatePickerProps {
  /** YYYY-MM-DD */
  value: string
  onChange: (value: string) => void
  /** 可选范围边界，YYYY-MM-DD */
  min?: string
  max?: string
  className?: string
  'aria-label'?: string
}

/**
 * 单日选择器。和 `DateRangePicker` 一套做法：headlessui `Popover` 负责
 * 点外面关 / Esc 关 / 关掉后焦点回到触发器，日历自绘。
 *
 * 换掉原生 `<input type="date">` 的原因不是好看：原生控件在 Safari 和
 * Firefox 上长得完全不一样，格式跟着系统区域设置走，中文环境下经常显示成
 * mm/dd/yyyy，跟页面上其他地方的日期对不上。
 */
export function DatePicker({
  value,
  onChange,
  min,
  max,
  className = '',
  'aria-label': ariaLabel,
}: DatePickerProps) {
  const field = useFieldControl()
  const [month, setMonth] = useState(() => {
    const d = parseOrToday(value)
    return new Date(d.getFullYear(), d.getMonth(), 1)
  })

  const today = toDateInputValue(new Date())
  const outOfRange = (iso: string) => (min != null && iso < min) || (max != null && iso > max)

  function pick(iso: string, close: () => void) {
    if (outOfRange(iso)) return
    onChange(iso)
    close()
  }

  return (
    <Popover className={`relative ${className}`}>
      <PopoverButton
        id={field.id}
        aria-describedby={field.describedBy}
        aria-invalid={field.invalid || undefined}
        aria-label={ariaLabel}
        className={`${CONTROL_BASE} num flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
          field.invalid ? CONTROL_INVALID : ''
        }`}
      >
        <CalendarDots aria-hidden className="size-4 shrink-0 text-[var(--text-tertiary)]" />
        <span className="flex-1 truncate">{formatDateLabel(value)}</span>
      </PopoverButton>

      <PopoverPanel
        transition
        // anchor 会把面板挪到 portal 里再定位。记一笔表单本身是个能滚的弹层，
        // 不这么做的话日历会被表单的 overflow 裁掉半截。
        anchor={{ to: 'bottom start', gap: 4 }}
        aria-label="选择日期"
        className="z-200 w-[268px] rounded-xl bg-[var(--surface-1)] p-3 shadow-[var(--shadow-pop)] ring-1 ring-[var(--border-subtle)] transition duration-150 ease-out data-closed:-translate-y-1 data-closed:opacity-0 motion-reduce:transition-none"
      >
        {({ close }) => (
          <>
            <div className="mb-2 flex items-center justify-between">
              <button
                type="button"
                aria-label="上一月"
                onClick={() => setMonth((m) => addMonths(m, -1))}
                className="inline-flex size-6 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)]"
              >
                <CaretLeft aria-hidden className="size-4" />
              </button>
              {/* aria-live：换月是纯视觉变化，不播报的话读屏用户不知道翻到哪了 */}
              <span aria-live="polite" className="num text-[12.5px] font-semibold text-[var(--text-primary)]">
                {month.getFullYear()}年{month.getMonth() + 1}月
              </span>
              <button
                type="button"
                aria-label="下一月"
                onClick={() => setMonth((m) => addMonths(m, 1))}
                className="inline-flex size-6 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)]"
              >
                <CaretRight aria-hidden className="size-4" />
              </button>
            </div>

            <div className="grid grid-cols-7 gap-0.5" role="presentation">
              {WEEKDAYS.map((w) => (
                <div key={w} className="py-1 text-center text-[11px] text-[var(--text-tertiary)]">
                  {w}
                </div>
              ))}
              {monthGrid(month).map((d) => {
                const iso = toDateInputValue(d)
                const inMonth = d.getMonth() === month.getMonth()
                const selected = iso === value
                const disabled = outOfRange(iso)
                return (
                  <button
                    key={iso}
                    type="button"
                    disabled={disabled}
                    // aria-pressed 而不是只靠底色：读屏得知道选中的是哪一天
                    aria-pressed={selected}
                    aria-label={formatDateLabel(iso)}
                    onClick={() => pick(iso, close)}
                    className={`num h-7 rounded-md text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${
                      selected
                        ? 'bg-[var(--brand)] font-semibold text-[var(--brand-on)]'
                        : iso === today
                          ? 'bg-[var(--brand-soft)] font-semibold text-[var(--brand-text)] hover:bg-[var(--surface-selected)]'
                          : inMonth
                            ? 'text-[var(--text-primary)] hover:bg-[var(--surface-hover)]'
                            : 'text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)]'
                    }`}
                  >
                    {d.getDate()}
                  </button>
                )
              })}
            </div>

            <button
              type="button"
              disabled={outOfRange(today)}
              onClick={() => {
                setMonth(new Date())
                pick(today, close)
              }}
              className="mt-2 w-full rounded-md py-1 text-[11.5px] text-[var(--brand-text)] transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-40"
            >
              今天
            </button>
          </>
        )}
      </PopoverPanel>
    </Popover>
  )
}
