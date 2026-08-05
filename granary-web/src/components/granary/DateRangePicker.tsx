import { useEffect, useId, useRef, useState } from 'react'
import { CalendarDaysIcon, ChevronDownIcon } from '@heroicons/react/20/solid'
import { useDateRangeStore } from '../../store/dateRangeStore'
import {
  DATE_RANGE_PRESETS,
  isValidIsoDate,
  presetShortLabel,
  type DateRangePreset,
} from '../../lib/dateRange'
import { formatMonthDay } from '../../lib/format'

/**
 * 顶栏日期范围选择器：预设一键切换 + 自定义起止日。
 * 改动写入 dateRangeStore；持久化由 DateRangePreferenceSync 负责。
 */
export function DateRangePicker({ compact = false }: { compact?: boolean }) {
  const start = useDateRangeStore((s) => s.start)
  const end = useDateRangeStore((s) => s.end)
  const preset = useDateRangeStore((s) => s.preset)
  const setRange = useDateRangeStore((s) => s.setRange)
  const applyPreset = useDateRangeStore((s) => s.applyPreset)

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
    applyPreset(id)
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
    setRange({ start: draftStart, end: draftEnd, preset: 'custom' })
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
          open ? 'bg-gray-100 dark:bg-gray-800' : 'bg-transparent'
        } text-gray-500 dark:text-gray-400`}
      >
        <CalendarDaysIcon aria-hidden className="size-3.5 text-gray-400" />
        <span className="text-gray-900 dark:text-gray-100">{label}</span>
        <ChevronDownIcon aria-hidden className="size-3 text-gray-400" />
      </button>

      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label="选择日期范围"
          // 桌面：右对齐触发器；移动端 compact 居中，避免居中按钮 + right-0 把面板裁出视口
          className={`absolute z-50 mt-1 w-[280px] rounded-xl bg-white p-3 shadow-lg ring-1 ring-gray-200 dark:bg-gray-900 dark:ring-gray-700 ${
            compact ? 'left-1/2 -translate-x-1/2' : 'right-0'
          }`}
        >
          <div
            className="mb-2 text-[11px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400"
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
                      ? 'bg-indigo-600 font-semibold text-white shadow-sm'
                      : 'bg-gray-100 text-gray-900 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700'
                  }`}
                >
                  {p.label}
                </button>
              )
            })}
          </div>

          <div
            className="mb-2 text-[11px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400"
          >
            自定义
          </div>
          <div className="flex flex-col gap-2">
            <label className="flex items-center justify-between gap-2 text-[12px] text-gray-500 dark:text-gray-400">
              开始
              <input
                type="date"
                value={draftStart}
                onChange={(e) => {
                  setDraftStart(e.target.value)
                  setError(null)
                }}
                className="rounded-md bg-gray-100 px-2 py-1 font-mono text-[12px] text-gray-900 outline-none ring-1 ring-inset ring-gray-300 dark:bg-gray-800 dark:text-gray-100 dark:ring-gray-600"
              />
            </label>
            <label className="flex items-center justify-between gap-2 text-[12px] text-gray-500 dark:text-gray-400">
              结束
              <input
                type="date"
                value={draftEnd}
                onChange={(e) => {
                  setDraftEnd(e.target.value)
                  setError(null)
                }}
                className="rounded-md bg-gray-100 px-2 py-1 font-mono text-[12px] text-gray-900 outline-none ring-1 ring-inset ring-gray-300 dark:bg-gray-800 dark:text-gray-100 dark:ring-gray-600"
              />
            </label>
            {error && (
              <div className="text-[11px] text-red-600 dark:text-red-400">
                {error}
              </div>
            )}
            <button
              type="button"
              onClick={applyCustom}
              className="mt-0.5 rounded-md bg-indigo-600 px-2.5 py-1.5 text-[13px] font-semibold text-white shadow-sm hover:bg-indigo-500"
            >
              应用自定义范围
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
