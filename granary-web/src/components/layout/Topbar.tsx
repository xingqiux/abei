import { Search, Plus } from 'lucide-react'
import { useRecordTxStore } from '../../store/recordTxStore'
import { useCommandPaletteStore } from '../../store/commandPaletteStore'
import { DateRangePicker } from '../granary/DateRangePicker'

export function Topbar() {
  const openRecordForm = useRecordTxStore((s) => s.openForm)
  const openCommandPalette = useCommandPaletteStore((s) => s.openPalette)

  return (
    <header
      className="flex h-11 shrink-0 items-center gap-3 px-3 md:px-5"
      style={{ borderBottom: '1px solid var(--g-border)' }}
    >
      {/* 移动端：搜索 + 居中日期范围选择器（规范 §3） */}
      <div className="flex w-full items-center md:hidden">
        <button
          type="button"
          onClick={openCommandPalette}
          aria-label="搜索"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px]"
          style={{ background: 'var(--g-surface-2)' }}
        >
          <Search aria-hidden size={14} color="var(--g-ink-2)" />
        </button>
        <div className="flex flex-1 justify-center">
          <DateRangePicker compact />
        </div>
        <div className="w-7 shrink-0" aria-hidden />
      </div>

      {/* 桌面版：搜索框 + 日期范围选择器 + 「+ 记一笔」（规范 §3） */}
      <div className="hidden w-full items-center gap-3 md:flex">
        <div className="flex-1">
          <button
            type="button"
            onClick={openCommandPalette}
            className="flex w-full max-w-[320px] items-center justify-between rounded-[6px] px-2.5 py-1.5 text-left text-[12.5px]"
            style={{ background: 'var(--g-surface-2)', color: 'var(--g-ink-2)' }}
          >
            <span className="flex items-center gap-1.5">
              <Search aria-hidden size={14} color="var(--g-ink-2)" />
              搜索，或 Cmd+K
            </span>
            <kbd
              className="font-num rounded-[4px] px-1.5 text-[10px]"
              style={{ background: 'var(--g-surface)', color: 'var(--g-ink-2)', border: '1px solid var(--g-border)' }}
            >
              /
            </kbd>
          </button>
        </div>

        <DateRangePicker />

        <button
          type="button"
          onClick={openRecordForm}
          className="flex shrink-0 items-center gap-1 rounded-[6px] px-3 py-1.5 text-[12.5px]"
          style={{
            background: 'var(--g-accent)',
            color: 'var(--g-accent-ink)',
            fontWeight: 'var(--g-weight-demibold)',
          }}
        >
          <Plus aria-hidden size={14} color="var(--g-accent-ink)" />
          记一笔
        </button>
      </div>
    </header>
  )
}
