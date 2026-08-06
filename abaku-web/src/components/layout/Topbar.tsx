import { ArrowRightStartOnRectangleIcon, MagnifyingGlassIcon, PlusIcon } from '@heroicons/react/20/solid'
import { useRecordTxStore } from '../../store/recordTxStore'
import { useCommandPaletteStore } from '../../store/commandPaletteStore'
import { DateRangePicker } from '../abaku/DateRangePicker'
import { Button, IconButton } from '../ui/Button'
import { requestTokenReset } from '../tokenEvents'

export function Topbar() {
  const openRecordForm = useRecordTxStore((s) => s.openForm)
  const openCommandPalette = useCommandPaletteStore((s) => s.openPalette)

  return (
    <header className="flex h-16 shrink-0 items-center gap-3 border-b border-[var(--border-subtle)] bg-[var(--surface-1)] px-4 md:px-6  ">
      {/* 移动端：搜索 + 居中日期范围选择器 */}
      <div className="flex w-full items-center md:hidden">
        <IconButton label="搜索" onClick={openCommandPalette}>
          <MagnifyingGlassIcon aria-hidden className="size-5" />
        </IconButton>
        <div className="flex flex-1 justify-center">
          <DateRangePicker compact />
        </div>
        <div className="w-9 shrink-0" aria-hidden />
      </div>

      {/* 桌面版：搜索框 + 日期范围选择器 + 「+ 记一笔」 */}
      <div className="hidden w-full items-center gap-4 md:flex">
        <div className="flex-1">
          <button
            type="button"
            onClick={openCommandPalette}
            className="flex w-full max-w-xs items-center justify-between gap-2 rounded-md bg-[var(--surface-1)] px-3 py-1.5 text-sm text-[var(--text-secondary)] shadow-sm ring-1 ring-inset ring-[var(--border-strong)] hover:bg-[var(--surface-hover)]   "
          >
            <span className="flex items-center gap-2">
              <MagnifyingGlassIcon aria-hidden className="size-4 text-[var(--text-tertiary)]" />
              搜索，或 Cmd+K
            </span>
            <kbd className="rounded border border-[var(--border-strong)] px-1.5 py-0.5 font-sans text-[10px] text-[var(--text-tertiary)] ">/</kbd>
          </button>
        </div>

        <DateRangePicker />

        <Button variant="primary" size="sm" className="shrink-0" onClick={openRecordForm}>
          <PlusIcon aria-hidden className="size-4" />
          记一笔
        </Button>
        <IconButton label="更换令牌" onClick={requestTokenReset}>
          <ArrowRightStartOnRectangleIcon aria-hidden className="size-5" />
        </IconButton>
      </div>
    </header>
  )
}
