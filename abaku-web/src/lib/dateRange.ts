import { addMonths, monthRange, toDateInputValue } from './format'

/** 全局日期范围预设（顶栏选择器 + preferences 持久化） */
export type DateRangePreset = 'last7' | 'last30' | 'thisMonth' | 'lastMonth' | 'custom'

export const DATE_RANGE_PRESETS: { id: Exclude<DateRangePreset, 'custom'>; label: string }[] = [
  { id: 'last7', label: '近 7 天' },
  { id: 'last30', label: '近 30 天' },
  { id: 'thisMonth', label: '本月' },
  { id: 'lastMonth', label: '上月' },
]

/** Firefly preference 名：自定义键，与 Firefly 原生 viewRange 等隔离 */
// 存储键沿用 granary.* 前缀：服务端偏好与本地键一起迁不划算，等下次有破坏性变更时再动。不是漏改。
export const GRANARY_DATE_RANGE_PREF = 'granary.date_range'

export interface DateRangeValue {
  start: string
  end: string
  preset: DateRangePreset
}

/** 滚动预设：相对「今天」重算；custom 不走此函数 */
export function rangeFromPreset(
  preset: Exclude<DateRangePreset, 'custom'>,
  now = new Date(),
): { start: string; end: string } {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (preset === 'last7') {
    const start = new Date(end)
    start.setDate(start.getDate() - 6)
    return { start: toDateInputValue(start), end: toDateInputValue(end) }
  }
  if (preset === 'last30') {
    const start = new Date(end)
    start.setDate(start.getDate() - 29)
    return { start: toDateInputValue(start), end: toDateInputValue(end) }
  }
  if (preset === 'thisMonth') {
    return monthRange(end)
  }
  // lastMonth
  return monthRange(addMonths(end, -1))
}

export function defaultDateRange(now = new Date()): DateRangeValue {
  const { start, end } = rangeFromPreset('last30', now)
  return { start, end, preset: 'last30' }
}

/** 顶栏短标签（不含具体日期） */
export function presetShortLabel(preset: DateRangePreset): string {
  if (preset === 'last7') return '近7天'
  if (preset === 'last30') return '近30天'
  if (preset === 'thisMonth') return '本月'
  if (preset === 'lastMonth') return '上月'
  return '自定义'
}

export function isRollingPreset(preset: DateRangePreset): preset is Exclude<DateRangePreset, 'custom'> {
  return preset !== 'custom'
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function isValidIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false
  const [y, m, d] = s.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
}

/** 校验并规范化 preference payload；无效返回 null */
export function parseDateRangePreference(raw: unknown): DateRangeValue | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const presetRaw = obj.preset
  const presets: DateRangePreset[] = ['last7', 'last30', 'thisMonth', 'lastMonth', 'custom']
  if (typeof presetRaw !== 'string' || !presets.includes(presetRaw as DateRangePreset)) return null
  const preset = presetRaw as DateRangePreset

  if (isRollingPreset(preset)) {
    // 滚动预设每次加载按今天重算，忽略过期的绝对日期
    const { start, end } = rangeFromPreset(preset)
    return { start, end, preset }
  }

  const start = typeof obj.start === 'string' ? obj.start : ''
  const end = typeof obj.end === 'string' ? obj.end : ''
  if (!isValidIsoDate(start) || !isValidIsoDate(end) || start > end) return null
  return { start, end, preset: 'custom' }
}
