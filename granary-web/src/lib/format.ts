const numberFormatter = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/** 格式化金额主体（不含符号/正负号）：1234.5 -> "1,234.50" */
export function formatAmount(value: number | string): string {
  if (typeof value === 'string') {
    const match = /^[+-]?(\d+)(?:\.(\d+))?$/.exec(value.trim())
    if (match) {
      const whole = match[1].replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',')
      const fraction = (match[2] ?? '').padEnd(2, '0')
      return `${whole}.${fraction || '00'}`
    }
  }
  const n = typeof value === 'string' ? Number(value) : value
  return numberFormatter.format(Math.abs(n))
}

export type TransactionKind = 'withdrawal' | 'deposit' | 'transfer' | (string & {})

/** 按谷仓规范格式化带符号金额：支出 -¥1,234.56 / 收入 +¥1,234.56 / 转账 ¥1,234.56 */
export function formatSignedAmount(value: number | string, kind: TransactionKind, symbol = '¥'): string {
  const body = `${symbol}${formatAmount(value)}`
  if (kind === 'withdrawal') return `-${body}`
  if (kind === 'deposit') return `+${body}`
  return body
}

/** 语义色 CSS 变量名（withdrawal=expense / deposit=income / transfer=transfer） */
export function kindColorVar(kind: TransactionKind): string {
  if (kind === 'withdrawal') return 'var(--g-expense)'
  if (kind === 'deposit') return 'var(--g-income)'
  if (kind === 'transfer') return 'var(--g-transfer)'
  return 'var(--g-ink)'
}

/** YYYY-MM-DD，本地时区 */
export function toDateInputValue(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const weekdayLabels = ['日', '一', '二', '三', '四', '五', '六']

/**
 * 解析 "YYYY-MM-DD" 为本地日期（不经过 UTC 转换）。
 * `new Date("YYYY-MM-DD")` 会被当作 UTC 零点解析，在 UTC 负偏移时区（如太平洋时区）
 * 会显示成前一天，因此这里手动拆分年月日构造本地 Date。
 */
function parseDateOnlyLocal(isoDate: string): Date {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** "MM-DD 周X" */
export function formatDayGroupLabel(isoDate: string): string {
  const d = parseDateOnlyLocal(isoDate)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${m}-${day} 周${weekdayLabels[d.getDay()]}`
}

/** "MM-DD" */
export function formatMonthDay(isoDate: string): string {
  const d = parseDateOnlyLocal(isoDate)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${m}-${day}`
}

/** "MM-DD HH:mm"，输入带时区偏移（如 +08:00）的完整 ISO 时间戳 */
export function formatDateTime(isoDateTime: string): string {
  const d = new Date(isoDateTime)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${m}-${day} ${hh}:${mm}`
}

/** "2026年7月"，报表页月份切换器标题 */
export function formatMonthLabel(d: Date): string {
  return `${d.getFullYear()}年${d.getMonth() + 1}月`
}

/** 以 d 所在月份的 1 号为基准，加 delta 个月（可为负）；返回新月份的 1 号 */
export function addMonths(d: Date, delta: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + delta, 1)
}

/** d 所在自然月的 [YYYY-MM-01, YYYY-MM-最后一天] 日期范围（本地时区） */
export function monthRange(d: Date): { start: string; end: string } {
  const start = new Date(d.getFullYear(), d.getMonth(), 1)
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 0)
  return { start: toDateInputValue(start), end: toDateInputValue(end) }
}
