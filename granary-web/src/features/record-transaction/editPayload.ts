import type { TransactionSplit } from '../../api/schemas'
import type { CreateTransactionType } from '../../api/firefly'
import type { RecordTxEditPayload } from '../../store/recordTxStore'

function asId(v: string | number | null | undefined): string | undefined {
  if (v === null || v === undefined || v === '') return undefined
  return String(v)
}

function asEditType(type: string): CreateTransactionType {
  if (type === 'deposit' || type === 'transfer' || type === 'withdrawal') return type
  // 对账/开户余额等：按支出展示但保存时仍原样受限——v1 行操作通常只对主三类开放
  return 'withdrawal'
}

/**
 * 从列表/详情的 group + 首笔 split 构造编辑负载。
 * date 取前 10 位本地日（避免 `new Date('YYYY-MM-DD')` UTC 偏一天）。
 */
export function buildEditPayload(
  groupId: string,
  split: TransactionSplit,
  splitCount: number,
): RecordTxEditPayload {
  const journalId = asId(split.transaction_journal_id) ?? groupId
  const tags = split.tags?.filter(Boolean) ?? []
  return {
    groupId,
    journalId,
    splitCount,
    type: asEditType(split.type),
    amount: String(Number(split.amount)),
    description: split.description,
    date: split.date.slice(0, 10),
    sourceId: asId(split.source_id),
    sourceName: split.source_name ?? undefined,
    destId: asId(split.destination_id),
    destName: split.destination_name ?? undefined,
    category: split.category_name ?? undefined,
    tagsRaw: tags.length > 0 ? tags.join(', ') : undefined,
    notes: split.notes ?? undefined,
  }
}
