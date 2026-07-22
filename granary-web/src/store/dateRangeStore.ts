import { create } from 'zustand'
import {
  defaultDateRange,
  type DateRangePreset,
  type DateRangeValue,
  rangeFromPreset,
  isRollingPreset,
} from '../lib/dateRange'

interface DateRangeState extends DateRangeValue {
  /** 是否已从 preferences / 默认值完成首次 hydration（避免把默认值写回服务端） */
  hydrated: boolean
  setRange: (next: DateRangeValue) => void
  applyPreset: (preset: Exclude<DateRangePreset, 'custom'>) => void
  /** 服务端偏好或本地默认灌入；仅 hydration 路径调用 */
  hydrate: (next: DateRangeValue) => void
  markHydrated: () => void
  reset: () => void
}

export const useDateRangeStore = create<DateRangeState>((set) => ({
  ...defaultDateRange(),
  hydrated: false,
  setRange: (next) => set({ ...next }),
  applyPreset: (preset) => {
    const { start, end } = rangeFromPreset(preset)
    set({ start, end, preset })
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
  reset: () => set({ ...defaultDateRange(), hydrated: false }),
}))
