import { useState } from 'react'
import type { BillQueueRow } from '../../api/schemas'
import { useUpdateBillStatementRow } from '../../api/queries'
import { CategoryPicker, DOMAINS_BY_TX_TYPE, type CategoryDomain } from '../../components/abei/CategoryPicker'
import { Button } from '../../components/ui/Button'
import { AbeiApiError } from '../../api/client'
import { isPositiveDecimal, normalizeDecimalString } from '../../lib/decimal'
import { showToast } from '../../store/toastStore'
import { rowAmount, rowDate, rowDescription, type AttentionKind } from './billInboxHelpers'

/**
 * 行内编辑控件。`Field` 那套是竖排 label + 控件，这里格子小、字段多，
 * label 只能走 aria-label，所以复用 Field 的 outline 写法把尺寸压下来。
 */
const CELL =
  'rounded px-1.5 py-1 text-xs bg-[var(--surface-2)] text-[var(--text-primary)] '
  + 'outline-1 -outline-offset-1 outline-[var(--border-strong)] placeholder:text-[var(--text-tertiary)] '
  + 'focus:outline-2 focus:-outline-offset-2 focus:outline-[var(--focus-ring)]'

function asText(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** 收支流水默认只让挑收入 / 支出域；识别成转账的行才放开资金往来 */
function domainsFor(fireflyType: string): CategoryDomain[] {
  if (fireflyType === 'withdrawal' || fireflyType === 'deposit' || fireflyType === 'transfer') {
    return DOMAINS_BY_TX_TYPE[fireflyType]
  }
  return ['income', 'expense']
}

/**
 * 一行的编辑态。
 *
 * 只在 editing 为真时挂载，所以九个表单字段的初值直接从 row 读——
 * 原先这些 state 常驻在 QueueRow 上，还得在 startEdit 里手动灌一遍，
 * 灌漏一个就是「上次编辑的值串到这次」。挂载即初始化，没有可漏的地方。
 */
export function QueueRowEditor({
  row,
  attentionKind,
  onEndEdit,
}: {
  row: BillQueueRow
  attentionKind?: AttentionKind
  onEndEdit: () => void
}) {
  const a = row.attributes
  const updateMutation = useUpdateBillStatementRow()

  const initialDescription = rowDescription(a)
  const [desc, setDesc] = useState(initialDescription === '--' ? '' : initialDescription)
  const [category, setCategory] = useState(() => asText(a.category_name))
  const [amount, setAmount] = useState(() => rowAmount(a))
  const [transactionType, setTransactionType] = useState(a.firefly_type ?? '')
  const [date, setDate] = useState(() => rowDate(a)?.slice(0, 10) ?? '')
  const [source, setSource] = useState(() => asText(a.source_name))
  const [destination, setDestination] = useState(() => asText(a.destination_name))
  const [notes, setNotes] = useState(() => asText(a.notes))

  async function saveEdit() {
    const descTrim = desc.trim()
    const sourceTrim = source.trim()
    const destinationTrim = destination.trim()
    if (!transactionType || !date || !descTrim || !sourceTrim || !destinationTrim) {
      showToast({ message: '请补全类型、日期、描述和账户流向', kind: 'error' })
      return
    }
    let amountStr: string
    try {
      if (!amount.trim() || !isPositiveDecimal(amount)) throw new Error('invalid amount')
      amountStr = normalizeDecimalString(amount)
    } catch {
      showToast({ message: '请输入大于 0 的金额', kind: 'error' })
      return
    }
    try {
      // 只写「要记成什么」，不碰银行原文（amount / description / occurred_at / counterparty）：
      // 那几个字段 rows.update 根本不收，原文得留着当对账依据。
      await updateMutation.mutateAsync({
        rowId: row.id,
        input: {
          firefly_type: transactionType as 'withdrawal' | 'deposit' | 'transfer',
          firefly_date: date,
          firefly_description: descTrim,
          source_name: sourceTrim,
          destination_name: destinationTrim,
          category_name: category.trim() || null,
          notes: notes.trim() || null,
          firefly_amount: amountStr,
        },
      })
      onEndEdit()
      showToast({ message: '已保存', kind: 'success' })
    } catch (err) {
      const message = err instanceof AbeiApiError ? err.message : '保存失败，请重试'
      showToast({ message, kind: 'error', duration: 6000 })
    }
  }

  return (
    <div
      className="mx-2 mb-2 grid grid-cols-2 gap-2 rounded-md bg-[var(--surface-2)] p-2 sm:grid-cols-4"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onEndEdit()
        }
        if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) {
          event.preventDefault()
          void saveEdit()
        }
      }}
    >
      <select
        value={transactionType}
        onChange={(e) => setTransactionType(e.target.value)}
        aria-label="交易类型"
        className={CELL}
      >
        <option value="">类型</option>
        <option value="withdrawal">支出</option>
        <option value="deposit">收入</option>
        <option value="transfer">转账</option>
      </select>
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="交易日期" className={CELL} />
      <input value={desc} onChange={(e) => setDesc(e.target.value)} aria-label="描述" placeholder="描述" className={`${CELL} col-span-2`} />
      <CategoryPicker
        value={category || null}
        onChange={(name) => setCategory(name ?? '')}
        domains={domainsFor(transactionType)}
        aria-label="分类"
        placeholder="分类"
      />
      <input value={source} onChange={(e) => setSource(e.target.value)} aria-label="来源账户" placeholder="来源账户" className={CELL} />
      <input value={destination} onChange={(e) => setDestination(e.target.value)} aria-label="目标账户" placeholder="目标账户" className={CELL} />
      <input
        value={amount}
        onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
        aria-label="金额"
        inputMode="decimal"
        className={`${CELL} num text-right`}
      />
      <input
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        aria-label="备注"
        placeholder="备注"
        // 「需修正」多半缺的就是描述/备注这一格，光标直接落这儿
        autoFocus={attentionKind === 'needs_fix'}
        className={`${CELL} col-span-2 sm:col-span-3`}
      />
      <div className="col-span-2 flex items-center justify-end gap-1.5 sm:col-span-1">
        <Button size="xs" variant="ghost" disabled={updateMutation.isPending} onClick={onEndEdit}>
          取消
        </Button>
        <Button size="xs" variant="primary" disabled={updateMutation.isPending} onClick={() => void saveEdit()}>
          {updateMutation.isPending ? '保存中…' : '保存'}
        </Button>
      </div>
    </div>
  )
}
