import { ArrowRightStartOnRectangleIcon, MagnifyingGlassIcon, PlusIcon } from '@heroicons/react/20/solid'
import { useRecordTxStore } from '../../store/recordTxStore'
import { useCommandPaletteStore } from '../../store/commandPaletteStore'
import { DateRangePicker } from '../granary/DateRangePicker'
import { requestTokenReset } from '../tokenEvents'

export function Topbar() {
  const openRecordForm = useRecordTxStore((s) => s.openForm)
  const openCommandPalette = useCommandPaletteStore((s) => s.openPalette)

  return (
    <header className="flex h-16 shrink-0 items-center gap-3 border-b border-gray-200 bg-white px-4 md:px-6 dark:border-gray-800 dark:bg-gray-900">
      {/* 移动端：搜索 + 居中日期范围选择器 */}
      <div className="flex w-full items-center md:hidden">
        <button
          type="button"
          onClick={openCommandPalette}
          aria-label="搜索"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:hover:bg-gray-800"
        >
          <MagnifyingGlassIcon aria-hidden className="size-5" />
        </button>
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
            className="flex w-full max-w-xs items-center justify-between gap-2 rounded-md bg-white px-3 py-1.5 text-sm text-gray-500 shadow-sm ring-1 ring-inset ring-gray-300 hover:bg-gray-50 dark:bg-gray-800 dark:ring-gray-700 dark:hover:bg-gray-700"
          >
            <span className="flex items-center gap-2">
              <MagnifyingGlassIcon aria-hidden className="size-4 text-gray-400" />
              搜索，或 Cmd+K
            </span>
            <kbd className="rounded border border-gray-300 px-1.5 py-0.5 font-sans text-[10px] text-gray-400 dark:border-gray-600">/</kbd>
          </button>
        </div>

        <DateRangePicker />

        <button
          type="button"
          onClick={openRecordForm}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500"
        >
          <PlusIcon aria-hidden className="size-4" />
          记一笔
        </button>
        <button
          type="button"
          title="更换令牌"
          aria-label="更换令牌"
          onClick={requestTokenReset}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
        >
          <ArrowRightStartOnRectangleIcon aria-hidden className="size-5" />
        </button>
      </div>
    </header>
  )
}
