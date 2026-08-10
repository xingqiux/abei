import type { UpdateTransactionInput } from '../../api/firefly'
import type { TransactionSplit } from '../../api/schemas'

/**
 * 从已加载的拆分构造可 PUT 的完整负载，并套用覆盖项（无覆盖则保持原值）。
 *
 * 注意 PUT /transactions/{id} 是整组替换：只发一条拆分就会把这一组里其余拆分抹掉。
 * 所以调用方必须先确认这一组只有一条拆分（批量编辑与右侧面板都是这么把关的）。
 */
export function splitToUpdateInput(
  tx: TransactionSplit,
  overrides: { categoryName?: string | null; budgetId?: string | null; tags?: string[] },
): UpdateTransactionInput {
  return {
    transaction_journal_id: tx.transaction_journal_id == null ? undefined : String(tx.transaction_journal_id),
    type: tx.type,
    date: tx.date.slice(0, 10),
    amount: tx.amount,
    description: tx.description,
    source_id: tx.source_id == null ? undefined : String(tx.source_id),
    source_name: tx.source_name ?? undefined,
    destination_id: tx.destination_id == null ? undefined : String(tx.destination_id),
    destination_name: tx.destination_name ?? undefined,
    category_name: overrides.categoryName !== undefined ? (overrides.categoryName ?? undefined) : (tx.category_name ?? undefined),
    budget_id: overrides.budgetId !== undefined ? overrides.budgetId : tx.budget_id == null ? null : String(tx.budget_id),
    tags: overrides.tags ?? tx.tags ?? [],
    notes: tx.notes ?? undefined,
    currency_id: tx.currency_id == null ? undefined : String(tx.currency_id),
    currency_code: tx.currency_code ?? undefined,
  }
}

/** 逗号（中英文都收）分隔的标签串 → 数组 */
export function parseTags(value: string): string[] {
  return value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean)
}
