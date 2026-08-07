import { useMemo } from 'react'
import { create } from 'zustand'
import {
  defaultDateRange,
  type DateRangePreset,
  type DateRangeValue,
  rangeFromPreset,
  isRollingPreset,
} from '../lib/dateRange'

export type PageKey = 'today' | 'transactions' | 'budgets'

/** 只有实际消费顶栏日期范围的页面才在这里占一个槽位。 */
export const PAGE_DEFAULT: Record<PageKey, Exclude<DateRangePreset, 'custom'>> = {
  today: 'thisMonth',
  transactions: 'thisMonth',
  budgets: 'thisMonth',
}

interface DateRangeState extends DateRangeValue {
  /** 每页各自的日期范围；只有这个“最后用过的范围”写回 preferences */
  byPage: Partial<Record<PageKey, DateRangeValue>>
  /** 是否已从 preferences / 默认值完成首次 hydration（避免把默认值写回服务端） */
  hydrated: boolean
  setRange: (page: PageKey, next: DateRangeValue) => void
  applyPreset: (page: PageKey, preset: Exclude<DateRangePreset, 'custom'>) => void
  /** 服务端偏好或本地默认灌入；仅 hydration 路径调用 */
  hydrate: (next: DateRangeValue, byPage?: Partial<Record<PageKey, DateRangeValue>>) => void
  markHydrated: () => void
  reset: () => void
}

export const useDateRangeStore = create<DateRangeState>((set) => ({
  ...defaultDateRange(),
  byPage: {},
  hydrated: false,
  setRange: (page, next) =>
    set((s) => ({
      ...next,
      byPage: { ...s.byPage, [page]: next },
    })),
  applyPreset: (page, preset) => {
    const next: DateRangeValue = { ...rangeFromPreset(preset), preset }
    set((s) => ({
      ...next,
      byPage: { ...s.byPage, [page]: next },
    }))
  },
  hydrate: (next, byPage = {}) => {
    if (isRollingPreset(next.preset)) {
      const { start, end } = rangeFromPreset(next.preset)
      set({ start, end, preset: next.preset, byPage, hydrated: true })
      return
    }
    set({ ...next, byPage, hydrated: true })
  },
  markHydrated: () => set({ hydrated: true }),
  reset: () => set({ ...defaultDateRange(), byPage: {}, hydrated: false }),
}))

/** 某页当前生效的范围：没手动改过就用该页默认粒度。 */
export function usePageRange(page: PageKey): DateRangeValue {
  const stored = useDateRangeStore((s) => s.byPage[page])
  return useMemo(
    () => stored ?? { ...rangeFromPreset(PAGE_DEFAULT[page]), preset: PAGE_DEFAULT[page] },
    [stored, page],
  )
}
