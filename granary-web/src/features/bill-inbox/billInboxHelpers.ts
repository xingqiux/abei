import type { BillStatementRow, BillTaskStatus } from '../../api/schemas'
import type { ChipKind } from '../../components/granary/StatusChip'

/** 任务状态中文标签 + chip 语义色（parsed=ok / needs_secret+ready=warn / failed+unknown=danger / imported+ignored+cleaned=muted） */
export const TASK_STATUS_META: Record<BillTaskStatus, { label: string; kind: ChipKind }> = {
  received: { label: '已接收', kind: 'muted' },
  ready: { label: '待处理', kind: 'warn' },
  needs_secret: { label: '需验证码', kind: 'warn' },
  parsed: { label: '已解析', kind: 'ok' },
  imported: { label: '已入账', kind: 'muted' },
  failed: { label: '失败', kind: 'danger' },
  unknown: { label: '失败', kind: 'danger' },
  ignored: { label: '已忽略', kind: 'muted' },
  cleaned: { label: '已清理', kind: 'muted' },
}

export type InboxTab = 'parsed' | 'processing' | 'imported' | 'ignored'

export const TAB_CONFIG: { key: InboxTab; label: string; statuses: BillTaskStatus[] }[] = [
  { key: 'parsed', label: '待审', statuses: ['parsed'] },
  { key: 'processing', label: '需处理', statuses: ['ready', 'needs_secret', 'failed', 'unknown'] },
  { key: 'imported', label: '已入账', statuses: ['imported'] },
  { key: 'ignored', label: '已忽略', statuses: ['ignored'] },
]

/** 渠道 key 兜底中文名，正常情况下应优先用 /bill-inbox/summary 返回的 channel.name */
export const SOURCE_FALLBACK_LABELS: Record<string, string> = {
  alipay: '支付宝',
  wechat: '微信支付',
  cmb: '招商银行',
  boc: '中国银行',
}

/** 原始 direction 字段（中文）映射语义色：支出/收入/转账，其余（不计收支等）中性 */
export function directionColorVar(direction: string | null | undefined): string {
  if (direction === '支出') return 'var(--g-expense)'
  if (direction === '收入') return 'var(--g-income)'
  if (direction === '转账') return 'var(--g-transfer)'
  return 'var(--g-ink-2)'
}

export function directionSign(direction: string | null | undefined): '' | '+' | '-' {
  if (direction === '支出') return '-'
  if (direction === '收入') return '+'
  return ''
}

/** 行是否可勾选入账：仅 pending 且 duplicate_state=unique（规范 §4.4 行审阅） */
export function isRowSelectable(row: BillStatementRow): boolean {
  return row.attributes.status === 'pending' && row.attributes.duplicate_state === 'unique'
}

/** 非"待入账"行右侧的说明 chip：重复/冲突/已入账/失败/需拆分/已拆分 */
export function rowBadge(row: BillStatementRow): { label: string; kind: ChipKind } | null {
  const a = row.attributes
  if (a.status === 'imported') return { label: '已入账', kind: 'muted' }
  if (a.status === 'failed') return { label: '失败', kind: 'danger' }
  if (a.status === 'needs_split') return { label: '需拆分', kind: 'warn' }
  if (a.status === 'split') return { label: '已拆分', kind: 'muted' }
  if (a.duplicate_state === 'duplicate') return { label: '重复', kind: 'muted' }
  if (a.duplicate_state === 'conflict') return { label: '冲突', kind: 'warn' }
  return null
}
