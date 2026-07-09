import { create } from 'zustand'
import { toDateInputValue } from '../lib/format'

interface DateRangeState {
  start: string
  end: string
}

function defaultRange(): DateRangeState {
  const end = new Date()
  const start = new Date()
  start.setDate(start.getDate() - 29) // 最近 30 天（含首尾）
  return { start: toDateInputValue(start), end: toDateInputValue(end) }
}

export const useDateRangeStore = create<DateRangeState>(() => defaultRange())
