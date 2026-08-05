const numberFormatter = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/** 格式化金额主体（不含符号/正负号）：1234.5 -> "1,234.50" */
export function formatAmount(value: number | string): string {
  if (typeof value === 'string') {
    const match = /^[+-]?(\d+)(?:\.(\d+))?$/.exec(value.trim())
    if (match) {
      const mills = BigInt(`${match[1]}${(match[2] ?? '').padEnd(3, '0').slice(0, 3)}`)
      const cents = ((mills + 5n) / 10n).toString().padStart(3, '0')
      const whole = cents.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
      return `${whole}.${cents.slice(-2)}`
    }
  }
  const n = typeof value === 'string' ? Number(value) : value
  return numberFormatter.format(Math.abs(n))
}

export type TransactionKind = 'withdrawal' | 'deposit' | 'transfer' | (string & {})

/** 金额的语义。跟 Firefly 的 transaction type 解耦，因为 reconciliation 要按方向归类。 */
export type MoneySemantic = 'income' | 'expense' | 'transfer' | 'neutral'

export function semanticOf(kind: TransactionKind): MoneySemantic {
  if (kind === 'deposit') return 'income'
  if (kind === 'withdrawal') return 'expense'
  if (kind === 'transfer') return 'transfer'
  return 'neutral'
}

/** 语义 → 颜色。定稿：收入红、支出用正文色不上色、转账蓝。 */
export function semanticColorClass(s: MoneySemantic): string {
  if (s === 'income') return 'text-[var(--income)]'
  if (s === 'transfer') return 'text-[var(--transfer)]'
  return 'text-[var(--text-primary)]' // expense 和 neutral 都不上色
}

/** 按 Abaku 规范格式化带符号金额：支出 -¥1,234.56 / 收入 +¥1,234.56 / 转账 ¥1,234.56 */
export function formatSignedAmount(value: number | string, semantic: MoneySemantic, symbol = '¥'): string {
  const body = `${symbol}${formatAmount(value)}`
  if (semantic === 'expense') return `-${body}`
  if (semantic === 'income') return `+${body}`
  return body
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
