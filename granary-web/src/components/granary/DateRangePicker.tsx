import { useEffect, useId, useRef, useState } from 'react'
import { CalendarRange, ChevronDown } from 'lucide-react'
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
        className="font-num flex items-center gap-1.5 rounded-[6px] px-2 py-1.5 text-[11.5px]"
        style={{
          background: open ? 'var(--g-surface-2)' : 'transparent',
          color: 'var(--g-ink-2)',
          border: '1px solid transparent',
        }}
      >
        <CalendarRange aria-hidden size={13} color="var(--g-ink-2)" />
        <span style={{ color: 'var(--g-ink)' }}>{label}</span>
        <ChevronDown aria-hidden size={12} color="var(--g-ink-2)" />
      </button>

      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label="选择日期范围"
          // 桌面：右对齐触发器；移动端 compact 居中，避免居中按钮 + right-0 把面板裁出视口
          className={`absolute z-50 mt-1 w-[280px] rounded-[10px] p-3 ${
            compact ? 'left-1/2 -translate-x-1/2' : 'right-0'
          }`}
          style={{
            background: 'var(--g-surface)',
            boxShadow: 'var(--g-shadow)',
            border: '1px solid var(--g-border)',
          }}
        >
          <div
            className="mb-2 text-[11px]"
            style={{ color: 'var(--g-ink-2)', letterSpacing: '.04em', textTransform: 'uppercase' }}
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
                  className="rounded-[4px] px-2 py-1 text-[11.5px]"
                  style={{
                    background: active ? 'var(--g-accent)' : 'var(--g-surface-2)',
                    color: active ? 'var(--g-accent-ink)' : 'var(--g-ink)',
                    fontWeight: active ? 'var(--g-weight-demibold)' : 'var(--g-weight-regular)',
                  }}
                >
                  {p.label}
                </button>
              )
            })}
          </div>

          <div
            className="mb-2 text-[11px]"
            style={{ color: 'var(--g-ink-2)', letterSpacing: '.04em', textTransform: 'uppercase' }}
          >
            自定义
          </div>
          <div className="flex flex-col gap-2">
            <label className="flex items-center justify-between gap-2 text-[12px]" style={{ color: 'var(--g-ink-2)' }}>
              开始
              <input
                type="date"
                value={draftStart}
                onChange={(e) => {
                  setDraftStart(e.target.value)
                  setError(null)
                }}
                className="font-num rounded-[6px] px-2 py-1 text-[12px] outline-none"
                style={{
                  background: 'var(--g-surface-2)',
                  color: 'var(--g-ink)',
                  border: '1px solid var(--g-border)',
                  // 跟随页面 color-scheme（tokens.css dark/light），勿写死 dark
                }}
              />
            </label>
            <label className="flex items-center justify-between gap-2 text-[12px]" style={{ color: 'var(--g-ink-2)' }}>
              结束
              <input
                type="date"
                value={draftEnd}
                onChange={(e) => {
                  setDraftEnd(e.target.value)
                  setError(null)
                }}
                className="font-num rounded-[6px] px-2 py-1 text-[12px] outline-none"
                style={{
                  background: 'var(--g-surface-2)',
                  color: 'var(--g-ink)',
                  border: '1px solid var(--g-border)',
                }}
              />
            </label>
            {error && (
              <div className="text-[11px]" style={{ color: 'var(--g-danger)' }}>
                {error}
              </div>
            )}
            <button
              type="button"
              onClick={applyCustom}
              className="mt-0.5 rounded-[6px] px-2.5 py-1.5 text-[12.5px]"
              style={{
                background: 'var(--g-accent)',
                color: 'var(--g-accent-ink)',
                fontWeight: 'var(--g-weight-demibold)',
              }}
            >
              应用自定义范围
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
