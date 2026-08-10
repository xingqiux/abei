import { useState, type FormEvent } from 'react'
import { CalendarDots, CaretDown } from '@phosphor-icons/react'
import { Popover, PopoverButton, PopoverPanel } from '@headlessui/react'
import { useRouterState } from '@tanstack/react-router'
import { useDateRangeStore, usePageRange, type PageKey } from '../../store/dateRangeStore'
import { DATE_RANGE_PRESETS, isValidIsoDate, presetShortLabel } from '../../lib/dateRange'
import { formatMonthDay } from '../../lib/format'
import { Button } from '../ui/Button'
import { Field, Input } from '../ui/Field'

function pageKeyOf(pathname: string, search: Record<string, unknown>): PageKey | null {
  if (pathname === '/') return 'today'
  if (pathname === '/transactions' || pathname.startsWith('/transactions')) return 'transactions'
  if (pathname === '/accounts' && (search.view === 'budgets' || search.view === 'subscriptions')) return 'budgets'
  return null
}

const SECTION_LABEL = 'mb-2 text-[11px] font-medium tracking-wide text-[var(--text-secondary)] uppercase'

/**
 * 自定义起止日。单独拆出来是为了拿「面板一关就丢草稿」这个行为——
 * Popover 关闭时会卸载面板，这里的 state 跟着重置，不用再写一个跟着 open 跑的 effect。
 */
function CustomRangeForm({
  start,
  end,
  onApply,
}: {
  start: string
  end: string
  onApply: (start: string, end: string) => void
}) {
  const [draftStart, setDraftStart] = useState(start)
  const [draftEnd, setDraftEnd] = useState(end)
  const [error, setError] = useState<string | null>(null)

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!isValidIsoDate(draftStart) || !isValidIsoDate(draftEnd)) {
      setError('请输入有效日期')
      return
    }
    if (draftStart > draftEnd) {
      setError('开始日期不能晚于结束日期')
      return
    }
    onApply(draftStart, draftEnd)
  }

  // 真 form：填完直接回车就能应用，不用去够那颗按钮
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        <Field label="开始">
          <Input
            type="date"
            max={draftEnd || undefined}
            className="num px-2 text-xs"
            value={draftStart}
            onChange={(e) => { setDraftStart(e.target.value); setError(null) }}
          />
        </Field>
        <Field label="结束">
          <Input
            type="date"
            min={draftStart || undefined}
            className="num px-2 text-xs"
            value={draftEnd}
            onChange={(e) => { setDraftEnd(e.target.value); setError(null) }}
          />
        </Field>
      </div>
      {error && <p role="alert" className="text-xs text-[var(--danger)]">{error}</p>}
      <Button type="submit" variant="primary" size="sm" block className="mt-0.5">
        应用自定义范围
      </Button>
    </form>
  )
}

/**
 * 顶栏日期范围选择器：预设一键切换 + 自定义起止日。
 * 改动写入当前页的 byPage 槽位；持久化只跟 lastUsed，由 DateRangePreferenceSync 负责。
 *
 * 弹层走 headlessui `Popover`：点外面关、Esc 关、关掉之后焦点回到触发器，
 * 原先这三件是手写的 pointerdown/keydown 监听，最后一件根本没做。
 */
export function DateRangePicker({ compact = false }: { compact?: boolean }) {
  const location = useRouterState({ select: (s) => s.location })
  const page = pageKeyOf(location.pathname, location.search as Record<string, unknown>)
  const pageRange = usePageRange(page ?? 'today')
  const setRange = useDateRangeStore((s) => s.setRange)
  const applyPreset = useDateRangeStore((s) => s.applyPreset)
  const { start, end, preset } = pageRange

  if (!page) return null

  const label = compact
    ? `${formatMonthDay(start)} → ${formatMonthDay(end)}`
    : `${presetShortLabel(preset)} · ${formatMonthDay(start)} → ${formatMonthDay(end)}`

  return (
    <Popover className="relative shrink-0">
      <PopoverButton className="num flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] data-open:bg-[var(--surface-hover)]">
        <CalendarDots aria-hidden className="size-3.5 text-[var(--text-tertiary)]" />
        <span className="text-[var(--text-primary)]">{label}</span>
        <CaretDown aria-hidden className="size-3 text-[var(--text-tertiary)]" />
      </PopoverButton>

      <PopoverPanel
        transition
        aria-label="选择日期范围"
        // 桌面：右对齐触发器；移动端 compact 居中，避免居中按钮 + right-0 把面板裁出视口
        className={`absolute z-50 mt-1 w-[280px] rounded-xl bg-[var(--surface-1)] p-3 shadow-lg ring-1 ring-[var(--border-subtle)] transition duration-150 ease-out data-closed:-translate-y-1 data-closed:opacity-0 motion-reduce:transition-none ${
          compact ? 'left-1/2 -translate-x-1/2' : 'right-0'
        }`}
      >
        {({ close }) => (
          <>
            <div className={SECTION_LABEL}>快捷范围</div>
            <div className="mb-3 flex flex-wrap gap-1.5">
              {DATE_RANGE_PRESETS.map((p) => (
                <PresetButton
                  key={p.id}
                  label={p.label}
                  active={preset === p.id}
                  onClick={() => { applyPreset(page, p.id); close() }}
                />
              ))}
            </div>

            <div className={SECTION_LABEL}>自定义</div>
            <CustomRangeForm
              start={start}
              end={end}
              onApply={(nextStart, nextEnd) => {
                setRange(page, { start: nextStart, end: nextEnd, preset: 'custom' })
                close()
              }}
            />
          </>
        )}
      </PopoverPanel>
    </Popover>
  )
}

function PresetButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      // aria-pressed 而不是只靠底色：读屏得知道当前选的是哪一个
      aria-pressed={active}
      className={`rounded-md px-2 py-1 text-[11.5px] transition-colors ${
        active
          ? 'bg-[var(--brand)] font-semibold text-[var(--brand-on)] shadow-xs'
          : 'bg-[var(--surface-hover)] text-[var(--text-primary)] hover:bg-[var(--surface-selected)]'
      }`}
    >
      {label}
    </button>
  )
}
