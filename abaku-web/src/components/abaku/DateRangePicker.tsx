import { useEffect, useId, useRef, useState } from 'react'
import { CalendarDaysIcon, ChevronDownIcon } from '@heroicons/react/20/solid'
import { useRouterState } from '@tanstack/react-router'
import { useDateRangeStore, usePageRange, type PageKey } from '../../store/dateRangeStore'
import {
  DATE_RANGE_PRESETS,
  isValidIsoDate,
  presetShortLabel,
  type DateRangePreset,
} from '../../lib/dateRange'
import { formatMonthDay } from '../../lib/format'

function pageKeyOf(pathname: string): PageKey | null {
  if (pathname === '/transactions' || pathname.startsWith('/transactions')) return 'transactions'
  if (pathname === '/budgets' || pathname.startsWith('/budgets')) return 'budgets'
  if (pathname === '/reconciliation') return 'reconciliation'
  if (pathname === '/reports' || pathname === '/analysis') return 'analysis'
  return null
}

/**
 * 顶栏日期范围选择器：预设一键切换 + 自定义起止日。
 * 改动写入当前页的 byPage 槽位；持久化只跟 lastUsed，由 DateRangePreferenceSync 负责。
 */
export function DateRangePicker({ compact = false }: { compact?: boolean }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const page = pageKeyOf(pathname)
  const pageRange = usePageRange(page ?? 'transactions')
  const lastStart = useDateRangeStore((s) => s.start)
  const lastEnd = useDateRangeStore((s) => s.end)
  const lastPreset = useDateRangeStore((s) => s.preset)
  const setRange = useDateRangeStore((s) => s.setRange)
  const applyPreset = useDateRangeStore((s) => s.applyPreset)
  const start = page ? pageRange.start : lastStart
  const end = page ? pageRange.end : lastEnd
  const preset = page ? pageRange.preset : lastPreset

  const [open, setOpen] = useState(false)
  const [draftStart, setDraftStart] = useState(start)
  const [draftEnd, setDraftEnd] = useState(end)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const panelId = useId()

  useEffect(() => {
    if (!open) return
    setDraftStart(start)
    setDraftEnd(end)
    setError(null)
  }, [open, start, end])

  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  function pickPreset(id: Exclude<DateRangePreset, 'custom'>) {
    applyPreset(page, id)
    setOpen(false)
  }

  function applyCustom() {
    if (!isValidIsoDate(draftStart) || !isValidIsoDate(draftEnd)) {
      setError('请输入有效日期')
      return
    }
    if (draftStart > draftEnd) {
      setError('开始日期不能晚于结束日期')
      return
    }
    setRange(page, { start: draftStart, end: draftEnd, preset: 'custom' })
    setOpen(false)
  }

  const label = compact
    ? `${formatMonthDay(start)} → ${formatMonthDay(end)}`
    : `${presetShortLabel(preset)} · ${formatMonthDay(start)} → ${formatMonthDay(end)}`

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 font-mono text-[11.5px] ${
          open ? 'bg-[var(--surface-hover)] ' : 'bg-transparent'
        } text-[var(--text-secondary)] `}
      >
        <CalendarDaysIcon aria-hidden className="size-3.5 text-[var(--text-tertiary)]" />
        <span className="text-[var(--text-primary)] ">{label}</span>
        <ChevronDownIcon aria-hidden className="size-3 text-[var(--text-tertiary)]" />
      </button>

      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label="选择日期范围"
          // 桌面：右对齐触发器；移动端 compact 居中，避免居中按钮 + right-0 把面板裁出视口
          className={`absolute z-50 mt-1 w-[280px] rounded-xl bg-[var(--surface-1)] p-3 shadow-lg ring-1 ring-[var(--border-subtle)]   ${
            compact ? 'left-1/2 -translate-x-1/2' : 'right-0'
          }`}
        >
          <div
            className="mb-2 text-[11px] font-medium uppercase tracking-wide text-[var(--text-secondary)] "
          >
            快捷范围
          </div>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {DATE_RANGE_PRESETS.map((p) => {
              const active = preset === p.id
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => pickPreset(p.id)}
                  className={`rounded-md px-2 py-1 text-[11.5px] ${
                    active
                      ? 'bg-[var(--brand)] font-semibold text-white shadow-sm'
                      : 'bg-[var(--surface-hover)] text-[var(--text-primary)] hover:bg-[var(--surface-selected)]   '
                  }`}
                >
                  {p.label}
                </button>
              )
            })}
          </div>

          <div
            className="mb-2 text-[11px] font-medium uppercase tracking-wide text-[var(--text-secondary)] "
          >
            自定义
          </div>
          <div className="flex flex-col gap-2">
            <label className="flex items-center justify-between gap-2 text-[12px] text-[var(--text-secondary)] ">
              开始
              <input
                type="date"
                value={draftStart}
                onChange={(e) => {
                  setDraftStart(e.target.value)
                  setError(null)
                }}
                className="rounded-md bg-[var(--surface-hover)] px-2 py-1 font-mono text-[12px] text-[var(--text-primary)] outline-none ring-1 ring-inset ring-[var(--border-strong)]   "
              />
            </label>
            <label className="flex items-center justify-between gap-2 text-[12px] text-[var(--text-secondary)] ">
              结束
              <input
                type="date"
                value={draftEnd}
                onChange={(e) => {
                  setDraftEnd(e.target.value)
                  setError(null)
                }}
                className="rounded-md bg-[var(--surface-hover)] px-2 py-1 font-mono text-[12px] text-[var(--text-primary)] outline-none ring-1 ring-inset ring-[var(--border-strong)]   "
              />
            </label>
            {error && (
              <div className="text-[11px] text-[var(--danger)] ">
                {error}
              </div>
            )}
            <button
              type="button"
              onClick={applyCustom}
              className="mt-0.5 rounded-md bg-[var(--brand)] px-2.5 py-1.5 text-[13px] font-semibold text-white shadow-sm hover:bg-[var(--brand-hover)]"
            >
              应用自定义范围
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
