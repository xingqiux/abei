import { useMemo } from 'react'
import { create } from 'zustand'
import {
  defaultDateRange,
  type DateRangePreset,
  type DateRangeValue,
  rangeFromPreset,
  isRollingPreset,
} from '../lib/dateRange'

export type PageKey = 'transactions' | 'analysis' | 'budgets' | 'reconciliation'

/** 各页默认粒度（analysis 现在用自带月切换器，暂不消费这个默认值）。 */
export const PAGE_DEFAULT: Record<PageKey, Exclude<DateRangePreset, 'custom'>> = {
  transactions: 'thisMonth',
  analysis: 'last30',
  budgets: 'thisMonth',
  reconciliation: 'last30',
}

interface DateRangeState extends DateRangeValue {
  /** 每页各自的日期范围；只有这个“最后用过的范围”写回 preferences */
  byPage: Partial<Record<PageKey, DateRangeValue>>
  /** 是否已从 preferences / 默认值完成首次 hydration（避免把默认值写回服务端） */
  hydrated: boolean
  setRange: (page: PageKey | null, next: DateRangeValue) => void
  applyPreset: (page: PageKey | null, preset: Exclude<DateRangePreset, 'custom'>) => void
  /** 服务端偏好或本地默认灌入；仅 hydration 路径调用 */
  hydrate: (next: DateRangeValue) => void
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
      byPage: page ? { ...s.byPage, [page]: next } : s.byPage,
    })),
  applyPreset: (page, preset) => {
    const next: DateRangeValue = { ...rangeFromPreset(preset), preset }
    set((s) => ({
      ...next,
      byPage: page ? { ...s.byPage, [page]: next } : s.byPage,
    }))
  },
  hydrate: (next) => {
    if (isRollingPreset(next.preset)) {
      const { start, end } = rangeFromPreset(next.preset)
      set({ start, end, preset: next.preset, hydrated: true })
      return
    }
    set({ ...next, hydrated: true })
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
