import { useState } from 'react'
import type { BillQueueRow } from '../../api/schemas'
import { useCategoryFeedback, useUpdateBillStatementRow } from '../../api/queries'
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
  /** AI 建议过分类。人把建议改掉时才问要不要立成规则 */
  ai,
  /** 立规则用的模式：优先对手方，退回商家 / 来源账户 */
  counterparty,
  onEndEdit,
}: {
  row: BillQueueRow
  attentionKind?: AttentionKind
  ai: boolean
  counterparty: string
  onEndEdit: () => void
}) {
  const a = row.attributes
  const updateMutation = useUpdateBillStatementRow()
  const categoryFeedback = useCategoryFeedback()

  const initialDescription = rowDescription(a)
  const [desc, setDesc] = useState(initialDescription === '--' ? '' : initialDescription)
  const [category, setCategory] = useState(() => asText(a.category_name))
  /** 进编辑时的分类，用来判断人是不是把 AI 建议的那个改掉了。冻在挂载那一刻，行刷新也不动。 */
  const [categoryAtOpen] = useState(() => asText(a.category_name))
  const [makeRule, setMakeRule] = useState(false)
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
      // 反馈是「顺手学一条规则」，失败不该让人以为这一笔没存上，所以单独 catch
      if (makeRule && category.trim() && counterparty) {
        try {
          await categoryFeedback.mutateAsync({
            pattern: counterparty,
            category_name: category.trim(),
            make_rule: true,
          })
        } catch {
          showToast({ message: '已保存，但规则创建失败', kind: 'error', duration: 6000 })
        }
      }
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
      {/* AI 建议的分类被人改掉了：顺手问一句要不要立成规则，以后同一个对手方自动归这儿 */}
      {ai && counterparty !== '' && category.trim() !== '' && category.trim() !== categoryAtOpen.trim() && (
        <label className="col-span-2 flex items-center gap-2 text-[11.5px] text-[var(--text-secondary)] sm:col-span-4">
          <input
            type="checkbox"
            checked={makeRule}
            onChange={(e) => setMakeRule(e.target.checked)}
            className="size-4 accent-[var(--brand)]"
          />
          以后「{counterparty}」都归「{category.trim()}」
        </label>
      )}
      <input
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        aria-label="备注"
        placeholder="备注"
        autoFocus={attentionKind === 'note'}
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
