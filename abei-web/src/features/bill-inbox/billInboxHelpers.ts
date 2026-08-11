import type { BillMailboxSyncResult, BillQueueRow, BillTask, BillTaskStatus } from '../../api/schemas'
import type { ChipKind } from '../../components/abei/StatusChip'
import { isPositiveDecimal } from '../../lib/decimal'
import { BRAND_MARKS, type BrandKey, type PlatformKey } from './brandMarks'

/** 邮件状态中文标签 + chip 语义色（术语表：待解锁 / 解析失败 / 已忽略 / 已入账） */
export const TASK_STATUS_META: Record<BillTaskStatus, { label: string; kind: ChipKind }> = {
  received: { label: '已接收', kind: 'muted' },
  ready: { label: '待解析', kind: 'warn' },
  needs_secret: { label: '待解锁', kind: 'warn' },
  parsed: { label: '已解析', kind: 'ok' },
  imported: { label: '已入账', kind: 'muted' },
  failed: { label: '解析失败', kind: 'danger' },
  unknown: { label: '解析失败', kind: 'danger' },
  ignored: { label: '已忽略', kind: 'muted' },
  cleaned: { label: '已忽略', kind: 'muted' },
}

/**
 * 收件箱的四个状态 tab（设计稿 06 §一）。写在路由 search 的 `view` 上，
 * 可直链；undefined 等同 `importable`（待入账，默认那个）。
 */
export type InboxView = 'importable' | 'attention' | 'dismissed' | 'imported'

export const INBOX_VIEWS: InboxView[] = ['importable', 'attention', 'dismissed', 'imported']

export function isInboxView(value: unknown): value is InboxView {
  return typeof value === 'string' && (INBOX_VIEWS as string[]).includes(value)
}

export const INBOX_VIEW_LABELS: Record<InboxView, string> = {
  importable: '待入账',
  attention: '待确认',
  dismissed: '已忽略',
  imported: '已入账',
}

/** 默认落在「待入账」；search 里没写 view 时用它，别在页面里各写各的 */
export const DEFAULT_INBOX_VIEW: InboxView = 'importable'

/** 需要人动手的邮件：等密码，或者解析出错 */
export const STUCK_TASK_STATUSES: BillTaskStatus[] = ['needs_secret', 'failed', 'unknown']

/** 已经从收件箱移走的邮件，不进来源面板 */
export const CLOSED_TASK_STATUSES: BillTaskStatus[] = ['ignored', 'cleaned']

/** 渠道 key 兜底中文名，正常情况下应优先用 /bill-inbox/summary 返回的 channel.name */
export const SOURCE_FALLBACK_LABELS: Record<string, string> = {
  alipay: '支付宝',
  wechat: '微信支付',
  cmb: '招商银行',
  boc: '中国银行',
}

/**
 * 渠道名只写渠道本身（术语表）：后端的 channel.name 是「支付宝交易流水」这种
 * 带用途后缀的全称，摆在 chip 和分组头上又长又重复。
 */
export function channelDisplayName(key: string, name?: string | null): string {
  const trimmed = (name ?? '').trim()
  const stripped = trimmed.replace(/(交易流水明细|交易流水|账单流水明细|账单流水)$/u, '').trim()
  return stripped || trimmed || SOURCE_FALLBACK_LABELS[key] || key
}

/**
 * 来源面板每封邮件右侧那颗徽标（设计稿 06 §一·来源面板）。
 * 顺序有讲究：先说「你得动手」，再说「解析出多少」，最后才是「没事了」。
 */
export function mailStateBadge(task: BillTask): { label: string; kind: ChipKind } {
  const a = task.attributes
  if (a.status === 'needs_secret') return { label: '待解锁', kind: 'warn' }
  if (a.status === 'failed' || a.status === 'unknown') return { label: '解析失败', kind: 'danger' }

  const counts = a.row_counts
  if (counts.pending > 0) return { label: `解析出 ${counts.pending} 笔`, kind: 'ok' }
  if (counts.total > 0) return { label: '已入账完', kind: 'muted' }
  return TASK_STATUS_META[a.status]
}

/** 邮件主题：后端把它放在 summary 里，空的时候退回渠道名，别露出「任务 #12」 */
export function mailSubject(task: BillTask, channelLabel: string): string {
  const summary = (task.attributes.summary ?? '').trim()
  return summary || channelLabel
}

/** 忽略原因（后端 dismissed_reason）翻成人话，摆在「已忽略」每行行尾 */
export const DISMISS_REASON_LABELS: Record<string, string> = {
  user: '手动忽略',
  duplicate_auto: '判定重复',
  zero_amount: '0 元',
  task_archived: '整封邮件被忽略',
}

export function dismissReasonLabel(reason: string | null | undefined): string {
  const key = (reason ?? '').trim()
  if (key === '') return '手动忽略'
  return DISMISS_REASON_LABELS[key] ?? key
}

export function syncResultFeedback(
  attributes: BillMailboxSyncResult,
): { kind: 'success' | 'error'; message: string } {
  const error = attributes.errors?.find((value): value is string => typeof value === 'string' && value.trim() !== '')
  if (error) return { kind: 'error', message: error }

  const failed = attributes.failed + attributes.process_failed
  if (failed > 0) return { kind: 'error', message: `同步失败 ${attributes.failed}，解析失败 ${attributes.process_failed}` }
  if (attributes.scanned === 0) return { kind: 'success', message: '同步完成：未发现新的账单邮件' }

  return {
    kind: 'success',
    message: `同步完成：扫描 ${attributes.scanned}，新建 ${attributes.created}，处理 ${attributes.processed}`,
  }
}

/** 原始 direction 字段（中文）映射语义色的 Tailwind 文字类：支出/收入/转账，其余（不计收支等）中性 */
export function directionColorClass(direction: string | null | undefined): string {
  if (direction === '支出') return 'text-[var(--danger)] '
  if (direction === '收入') return 'text-[var(--done)] '
  if (direction === '转账') return 'text-[var(--brand-text)] '
  return 'text-[var(--text-secondary)] '
}

export function directionSign(direction: string | null | undefined): '' | '+' | '-' {
  if (direction === '支出') return '-'
  if (direction === '收入') return '+'
  return ''
}

function isValidCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]|$)/.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
}

/** 行是否可勾选入账：只允许后端能够完整入账的 pending/unique 草稿。 */
export function isRowSelectable(row: BillQueueRow): boolean {
  const a = row.attributes
  const date = a.firefly_date ?? a.occurred_at
  const description = a.firefly_description || (a as { description?: string | null }).description || a.counterparty
  try {
    return a.status === 'pending'
      && a.duplicate_state === 'unique'
      && !!a.firefly_type
      && !!date?.trim()
      && isValidCalendarDate(date)
      && !!a.firefly_amount?.trim()
      && isPositiveDecimal(a.firefly_amount)
      && !!description?.trim()
      && !!a.source_name?.trim()
      && !!a.destination_name?.trim()
  } catch {
    return false
  }
}

/** 非「待入账」行右侧的说明 chip：重复/冲突/已入账/失败/需拆分/已拆分/已忽略 */
export function rowBadge(row: BillQueueRow): { label: string; kind: ChipKind } | null {
  const a = row.attributes
  if (a.status === 'imported') return { label: '已入账', kind: 'muted' }
  if (a.status === 'dismissed') return { label: '已忽略', kind: 'muted' }
  if (a.status === 'failed') return { label: '入账失败', kind: 'danger' }
  if (a.status === 'needs_split') return { label: '需拆分', kind: 'warn' }
  if (a.status === 'split') return { label: '已拆分', kind: 'muted' }
  if (a.duplicate_state === 'duplicate') return { label: '重复', kind: 'muted' }
  if (a.duplicate_state === 'conflict') return { label: '冲突', kind: 'warn' }
  return null
}

/**
 * 「待确认」的分小节。后端给的是中文 reason 串，这里按关键词归到五类，
 * 每类配一组场景化动作（设计稿 02 §4）。
 *
 * 分类只看关键词而不是精确相等：reason 文案后端还在改，写死全串的话
 * 改一个字就整节掉进「其他」。
 */
export type AttentionKind = 'transfer' | 'duplicate' | 'note' | 'split' | 'conflict' | 'other'

export const ATTENTION_SECTIONS: { kind: AttentionKind; label: string }[] = [
  { kind: 'transfer', label: '疑似转账' },
  { kind: 'duplicate', label: '疑似重复' },
  { kind: 'note', label: '需补备注' },
  { kind: 'split', label: '需拆分' },
  { kind: 'conflict', label: '冲突' },
  { kind: 'other', label: '其他' },
]

export function attentionKindOf(row: BillQueueRow): AttentionKind {
  const a = row.attributes
  if (a.status === 'needs_split') return 'split'
  if (a.duplicate_state === 'conflict') return 'conflict'

  const reasons = (a.reasons ?? []).join(' ')
  if (reasons.includes('转账')) return 'transfer'
  if (reasons.includes('重复')) return 'duplicate'
  if (reasons.includes('备注')) return 'note'
  if (reasons.includes('拆分')) return 'split'
  if (reasons.includes('冲突')) return 'conflict'

  if (a.duplicate_state === 'duplicate') return 'duplicate'
  if (a.firefly_type === 'transfer') return 'transfer'
  return 'other'
}

export function groupAttentionRows(rows: BillQueueRow[]): { kind: AttentionKind; label: string; rows: BillQueueRow[] }[] {
  const byKind = new Map<AttentionKind, BillQueueRow[]>()
  for (const row of rows) {
    const kind = attentionKindOf(row)
    const list = byKind.get(kind)
    if (list) list.push(row)
    else byKind.set(kind, [row])
  }
  return ATTENTION_SECTIONS
    .map((section) => ({ ...section, rows: byKind.get(section.kind) ?? [] }))
    .filter((section) => section.rows.length > 0)
}

/** 这条流水的某个字段是不是 AI 建议的（设计稿 03 §3） */
export function isAiSuggested(row: BillQueueRow): boolean {
  const a = row.attributes
  return !!a.suggested_by && !a.user_modified_at
}

/** 还没被 AI 碰过、也没被人改过的 pending 行——「让 AI 出建议」按钮的显示条件 */
export function needsAutofill(row: BillQueueRow): boolean {
  const a = row.attributes
  if (a.status !== 'pending') return false
  if (a.suggested_by || a.user_modified_at) return false
  return !a.category_name?.trim() || !a.firefly_description?.trim() || !a.notes?.trim()
}

export function rowDescription(a: BillQueueRow['attributes']): string {
  const text = (value: unknown): string => (typeof value === 'string' ? value : '')
  return (
    text(a.firefly_description)
    || text(a.counterparty)
    || text((a as { description?: unknown }).description)
    || '--'
  )
}

export function rowAmount(a: BillQueueRow['attributes']): string {
  const raw = a.firefly_amount ?? a.amount
  return raw == null || raw === '' ? '0' : String(raw)
}

export function rowDate(a: BillQueueRow['attributes']): string | null {
  return a.firefly_date ?? a.occurred_at
}

/**
 * 一笔流水该挂哪个平台标。
 *
 * 找的顺序是有讲究的：先看描述和对手方（「支付宝-上海盒马」这种前缀最准），
 * 再看账户里那几个钱包产品（花呗、余额宝、云闪付），最后才退回这封邮件的渠道。
 * 不能一上来就看账户 —— 招行账单里每一行的账户都写着「招商银行信用卡」，
 * 那样整箱流水会全变成招行标，等于没标。
 */
const DESCRIPTION_HINTS: { key: BrandKey; patterns: string[] }[] = [
  { key: 'huabei', patterns: ['花呗'] },
  { key: 'tenpay', patterns: ['财付通'] },
  { key: 'alipay', patterns: ['支付宝', '余额宝', '蚂蚁'] },
  { key: 'wechat', patterns: ['微信'] },
  { key: 'unionpay', patterns: ['云闪付', '银联'] },
  { key: 'douyin', patterns: ['抖音'] },
  { key: 'meituan', patterns: ['美团'] },
  { key: 'pdd', patterns: ['拼多多'] },
  { key: 'jd', patterns: ['京东'] },
  { key: 'apple', patterns: ['Apple', 'iCloud', 'iTunes', 'App Store'] },
  { key: 'cmb', patterns: ['招商银行', '招行'] },
  { key: 'boc', patterns: ['中国银行'] },
]

/** 账户名里只认这几个钱包产品；银行名故意不认，理由见上 */
const ACCOUNT_HINTS: { key: BrandKey; patterns: string[] }[] = [
  { key: 'huabei', patterns: ['花呗'] },
  { key: 'alipay', patterns: ['余额宝', '支付宝'] },
  { key: 'wechat', patterns: ['微信', '零钱'] },
  { key: 'unionpay', patterns: ['云闪付'] },
]

function matchHint(text: string, table: { key: BrandKey; patterns: string[] }[]): BrandKey | null {
  const lower = text.toLowerCase()
  for (const hint of table) {
    if (hint.patterns.some((pattern) => lower.includes(pattern.toLowerCase()))) return hint.key
  }
  return null
}

export function rowPlatform(a: BillQueueRow['attributes']): PlatformKey {
  const described = matchHint(`${rowDescription(a)} ${a.counterparty ?? ''}`, DESCRIPTION_HINTS)
  if (described) return described

  const account = matchHint(`${a.source_name ?? ''} ${a.destination_name ?? ''}`, ACCOUNT_HINTS)
  if (account) return account

  const channel = a.task?.source
  if (channel && channel in BRAND_MARKS) return channel as BrandKey
  return 'other'
}

/**
 * 行上显示的商户名：平台前缀交给左边那枚标去说，描述里就别再印一遍。
 * 只砍「平台-」这一种前缀，砍完是空的就退回原文 —— 宁可重复，也不能把整行说没了。
 */
export function rowMerchant(a: BillQueueRow['attributes']): string {
  const text = rowDescription(a)
  const dash = text.search(/[-－—]/u)
  if (dash <= 0) return text
  const prefix = text.slice(0, dash)
  if (!matchHint(prefix, DESCRIPTION_HINTS)) return text
  const rest = text.slice(dash + 1).trim()
  return rest || text
}

/**
 * 行上那一格账户显示谁：钱从哪个账户出（支出）／进了哪个账户（收入）。
 * 另一端不是商户就是同一个户头，描述里已经有了。
 */
export function fundingAccount(a: BillQueueRow['attributes']): string {
  const source = (a.source_name ?? '').trim()
  const destination = (a.destination_name ?? '').trim()
  if (a.direction === '收入') return destination || source || '--'
  return source || destination || '--'
}

/** 一行的带符号金额，用来算当日合计：支出记负、收入记正、其余（转账等）不计 */
export function signedAmount(a: BillQueueRow['attributes']): number {
  const value = Number(rowAmount(a))
  if (!Number.isFinite(value)) return 0
  if (a.direction === '支出') return -value
  if (a.direction === '收入') return value
  return 0
}

export interface DayGroup {
  /** YYYY-MM-DD */
  day: string
  rows: BillQueueRow[]
  /** 当日合计（带符号），分组头右端那个数 */
  net: number
}

/**
 * 按日期分组。日期从每一行搬到分组头上：一封招行日账单解析出九笔，
 * 原来就是把同一个「08-08」原样印九遍。
 *
 * 保持行本来的先后顺序，不重排 —— 后端已经排过一次了。
 */
export function groupRowsByDay(rows: BillQueueRow[]): DayGroup[] {
  const groups: DayGroup[] = []
  const index = new Map<string, DayGroup>()
  for (const row of rows) {
    const day = (rowDate(row.attributes) ?? '').slice(0, 10) || '--'
    let group = index.get(day)
    if (!group) {
      group = { day, rows: [], net: 0 }
      index.set(day, group)
      groups.push(group)
    }
    group.rows.push(row)
    group.net += signedAmount(row.attributes)
  }
  return groups
}

/** 队列的工作量：多少笔、支出多少、收入多少、最早一笔是哪天 */
export function workloadOf(rows: BillQueueRow[]): {
  count: number
  expense: number
  income: number
  earliestDay: string | null
} {
  let expense = 0
  let income = 0
  let earliestDay: string | null = null
  for (const row of rows) {
    const value = signedAmount(row.attributes)
    if (value < 0) expense -= value
    else income += value
    const day = (rowDate(row.attributes) ?? '').slice(0, 10)
    if (day && (!earliestDay || day < earliestDay)) earliestDay = day
  }
  return { count: rows.length, expense, income, earliestDay }
}

/** 「昨天」「2 天前」；今天以内就说今天。传进来的两个都是 YYYY-MM-DD */
export function relativeDayLabel(day: string, today: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return null
  const diff = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86400000)
  if (!Number.isFinite(diff) || diff < 0) return null
  if (diff === 0) return '今天'
  if (diff === 1) return '昨天'
  return `${diff} 天前`
}

/** 「最早 6 月」：队列里最早那笔待处理流水落在哪个月 */
export function earliestMonthLabel(rows: BillQueueRow[]): string | null {
  let earliest: string | null = null
  for (const row of rows) {
    const date = rowDate(row.attributes)
    if (!date) continue
    const day = date.slice(0, 10)
    if (!earliest || day < earliest) earliest = day
  }
  if (!earliest) return null
  return `${Number(earliest.slice(5, 7))} 月`
}
