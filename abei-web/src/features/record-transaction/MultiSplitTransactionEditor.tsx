import { useEffect, useRef, useState } from 'react'
import { Plus, Trash } from '@phosphor-icons/react'
import {
  useAssetAccounts,
  useBudgets,
  useCreateTransactionSplits,
  useTransaction,
  useUpdateTransactionSplits,
} from '../../api/queries'
import type { CreateTransactionInput, CreateTransactionType, UpdateTransactionInput } from '../../api/firefly'
import { AbeiApiError } from '../../api/client'
import { showToast } from '../../store/toastStore'
import { isPositiveDecimal, normalizeDecimalString } from '../../lib/decimal'
import { toDateInputValue } from '../../lib/format'
import { useDateRangeStore } from '../../store/dateRangeStore'
import { SegmentedControl } from '../../components/ui/SegmentedControl'
import { Button, IconButton } from '../../components/ui/Button'
import { Field, Input, Select, Textarea } from '../../components/ui/Field'
import { AccountCombobox } from '../../components/abei/AccountCombobox'
import { CategoryPicker, DOMAINS_BY_TX_TYPE } from '../../components/abei/CategoryPicker'
import { DatePicker } from '../../components/abei/DatePicker'
import { InlineError } from '../../components/abei/ErrorState'
import { Skeleton } from '../../components/abei/Skeleton'

/**
 * 一条拆分的草稿。
 *
 * 这里没有币种和外币：多币种记账在这个产品里没人用过一次，三个字段却占掉拆分表单
 * 三分之一的高度，还带来「填了外币金额但没选外币」这类只可能出现在表单里的错误。
 * 币种沿用账户的，由 Firefly 决定。API 类型仍保留这几个字段，将来要加回来不用改后端。
 */
interface Draft {
  clientId: string
  journalId: string
  date: string
  amount: string
  description: string
  sourceId: string
  sourceName: string
  destinationId: string
  destinationName: string
  category: string
  tags: string[]
  notes: string
  budgetId?: string
  budgetName?: string
  categoryId?: string
  billId?: string
  billName?: string
}

const GROUP_TYPES = [
  { value: 'withdrawal' as const, label: '支出' },
  { value: 'deposit' as const, label: '收入' },
  { value: 'transfer' as const, label: '转账' },
]

/** 一行两格；窄屏下堆成一列，否则 520px 的弹层里两个带 label 的控件会挤成一团 */
const ROW = 'grid grid-cols-1 gap-2 sm:grid-cols-2'

let nextDraftId = 0

function draftClientId(prefix: 'new' | 'journal'): string {
  nextDraftId += 1
  return `${prefix}-${nextDraftId}`
}

function newDraft(template?: Draft): Draft {
  return {
    clientId: draftClientId('new'),
    journalId: '',
    date: template?.date ?? toDateInputValue(new Date()),
    amount: '',
    description: '',
    sourceId: template?.sourceId ?? '',
    sourceName: template?.sourceName ?? '',
    destinationId: template?.destinationId ?? '',
    destinationName: template?.destinationName ?? '',
    category: template?.category ?? '',
    tags: [],
    notes: '',
    budgetId: template?.budgetId,
    budgetName: template?.budgetName,
    categoryId: template?.categoryId,
    billId: template?.billId,
    billName: template?.billName,
  }
}

export function MultiSplitTransactionEditor({
  groupId,
  onSaved,
  onDirtyChange,
}: {
  groupId?: string
  onSaved: () => void
  onDirtyChange: (dirty: boolean) => void
}) {
  const query = useTransaction(groupId ?? null)
  const accounts = useAssetAccounts()
  const range = useDateRangeStore()
  const budgets = useBudgets(range)
  const mutation = useUpdateTransactionSplits()
  const createMutation = useCreateTransactionSplits()
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [groupType, setGroupType] = useState<CreateTransactionType>('withdrawal')
  const [groupTitle, setGroupTitle] = useState('')
  const initializedGroup = useRef<string | null>(null)

  useEffect(() => {
    const initializationKey = groupId ?? 'new-transaction'
    if (initializedGroup.current === initializationKey) return
    if (!groupId) {
      setGroupType('withdrawal')
      setGroupTitle('')
      setDrafts([newDraft(), newDraft()])
      initializedGroup.current = initializationKey
      onDirtyChange(false)
      return
    }
    const splits = query.data?.data.attributes.transactions
    if (!splits) return
    const editable = splits.filter((split) => split.type === 'withdrawal' || split.type === 'deposit' || split.type === 'transfer')
    if (editable[0]) setGroupType(editable[0].type as CreateTransactionType)
    setGroupTitle(query.data?.data.attributes.group_title ?? editable[0]?.description ?? '')
    setDrafts(editable.flatMap((split) => {
      if (split.type !== 'withdrawal' && split.type !== 'deposit' && split.type !== 'transfer') return []
      return [{
        clientId: split.transaction_journal_id == null
          ? draftClientId('journal')
          : `journal-${String(split.transaction_journal_id)}`,
        journalId: String(split.transaction_journal_id ?? ''),
        date: split.date.slice(0, 10),
        amount: normalizeDecimalString(split.amount),
        description: split.description,
        sourceId: split.source_id == null ? '' : String(split.source_id),
        sourceName: split.source_name ?? '',
        destinationId: split.destination_id == null ? '' : String(split.destination_id),
        destinationName: split.destination_name ?? '',
        category: split.category_name ?? '',
        tags: split.tags ?? [],
        notes: split.notes ?? '',
        budgetId: split.budget_id == null ? undefined : String(split.budget_id),
        budgetName: split.budget_name ?? undefined,
        categoryId: split.category_id == null ? undefined : String(split.category_id),
        billId: split.bill_id == null ? undefined : String(split.bill_id),
        billName: split.bill_name ?? undefined,
      }]
    }))
    initializedGroup.current = initializationKey
    onDirtyChange(false)
  }, [groupId, onDirtyChange, query.data])

  function update(index: number, patch: Partial<Draft>) {
    setDrafts((current) => current.map((draft, draftIndex) => draftIndex === index ? { ...draft, ...patch } : draft))
    onDirtyChange(true)
  }

  function changeType(type: CreateTransactionType) {
    if (type === groupType) return
    const assetIds = new Set((accounts.data ?? []).map((account) => account.id))
    // 「来源」这一格在收入时填的是付款方（自由文本），其余时候是资产账户；「目标」同理。
    // 一格的性质变了，里面存的文本就没意义了——把「星巴克」留在账户选择框里
    // 比清空更糟，它看着像已经选好了账户。
    const sourceStaysFree = (type === 'deposit') === (groupType === 'deposit')
    const destinationStaysFree = (type === 'withdrawal') === (groupType === 'withdrawal')
    setDrafts((current) => current.map((draft) => ({
      ...draft,
      sourceId: type === 'deposit' || !assetIds.has(draft.sourceId) ? '' : draft.sourceId,
      sourceName: sourceStaysFree ? draft.sourceName : '',
      destinationId: type === 'withdrawal' || !assetIds.has(draft.destinationId) ? '' : draft.destinationId,
      destinationName: destinationStaysFree ? draft.destinationName : '',
    })))
    setGroupType(type)
    onDirtyChange(true)
  }

  function addDraft() {
    const template = drafts[0]
    setDrafts((current) => [...current, newDraft(template)])
    onDirtyChange(true)
  }

  function removeDraft(clientId: string) {
    setDrafts((current) => current.filter((item) => item.clientId !== clientId))
    onDirtyChange(true)
  }

  async function save() {
    const minimumSplits = groupId ? 1 : 2
    if (drafts.length < minimumSplits) {
      showToast({ kind: 'error', message: groupId ? '交易至少要保留一个拆分' : '多拆分交易至少需要两个拆分' })
      return
    }
    const invalidAmount = drafts.some((draft) => {
      if (!draft.description.trim()) return true
      try {
        return !isPositiveDecimal(draft.amount)
      } catch {
        return true
      }
    })
    if (invalidAmount) {
      showToast({ kind: 'error', message: '每个拆分都必须有描述和正金额' })
      return
    }
    for (const draft of drafts) {
      if (!draft.date) {
        showToast({ kind: 'error', message: '每个拆分都要选择日期' })
        return
      }
      if ((groupType === 'withdrawal' || groupType === 'transfer') && !draft.sourceId) {
        showToast({ kind: 'error', message: '每个支出或转账拆分都要选择来源账户' })
        return
      }
      if ((groupType === 'deposit' || groupType === 'transfer') && !draft.destinationId) {
        showToast({ kind: 'error', message: '每个收入或转账拆分都要选择目标账户' })
        return
      }
      if (groupType === 'transfer' && draft.sourceId === draft.destinationId) {
        showToast({ kind: 'error', message: '转账的来源与目标账户不能相同' })
        return
      }
    }
    const inputs: CreateTransactionInput[] = drafts.map((draft, index) => ({
      type: groupType,
      order: index,
      date: draft.date,
      amount: normalizeDecimalString(draft.amount),
      description: draft.description.trim(),
      source_id: groupType === 'deposit' ? undefined : draft.sourceId,
      source_name: groupType === 'deposit' ? draft.sourceName.trim() : undefined,
      destination_id: groupType === 'withdrawal' ? undefined : draft.destinationId,
      destination_name: groupType === 'withdrawal' ? draft.destinationName.trim() : undefined,
      category_id: draft.categoryId,
      category_name: draft.category.trim(),
      budget_id: draft.budgetId ?? null,
      budget_name: draft.budgetName,
      bill_id: draft.billId ?? null,
      bill_name: draft.billName,
      tags: draft.tags,
      notes: draft.notes,
    }))
    try {
      if (groupId) {
        const updates: UpdateTransactionInput[] = inputs.map((input, index) => ({
          ...input,
          transaction_journal_id: drafts[index]?.journalId || undefined,
        }))
        await mutation.mutateAsync({ groupId, inputs: updates, groupTitle })
      } else {
        await createMutation.mutateAsync({ inputs, groupTitle })
      }
      showToast({ kind: 'success', message: groupId ? `已更新 ${inputs.length} 个拆分` : `已创建 ${inputs.length} 个拆分` })
      onSaved()
    } catch (error) {
      showToast({ kind: 'error', message: error instanceof AbeiApiError ? error.message : groupId ? '多拆分交易更新失败' : '多拆分交易创建失败', duration: 6000 })
    }
  }

  if (groupId && query.isLoading) {
    return (
      <div className="flex flex-col gap-2 py-2" role="status" aria-label="交易详情加载中">
        {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-8" />)}
      </div>
    )
  }
  if (groupId && query.isError) {
    return <InlineError message="交易详情加载失败" error={query.error} onRetry={() => void query.refetch()} />
  }

  const pending = mutation.isPending || createMutation.isPending
  const minimumSplits = groupId ? 1 : 2
  const activeBudgets = (budgets.data?.data ?? []).filter((item) => item.attributes.active !== false)
  const assetAccounts = accounts.data ?? []

  return (
    <div className="flex flex-col gap-3">
      <SegmentedControl aria-label="拆分交易类型" value={groupType} onChange={changeType} segments={GROUP_TYPES} />

      <Field label="交易组标题" hint="留空则用第一条拆分的描述">
        <Input
          value={groupTitle}
          onChange={(event) => { setGroupTitle(event.target.value); onDirtyChange(true) }}
          placeholder="默认使用第一条拆分描述"
        />
      </Field>

      {drafts.map((draft, index) => (
        /* fieldset + legend：读屏进到某一格时会先播「拆分 2」，
           不然十几个叫「金额」的输入框根本分不清是哪一条 */
        <fieldset key={draft.clientId} className="relative flex min-w-0 flex-col gap-2 border-b border-[var(--border-subtle)] pb-3">
          <legend className="num text-[11px] font-semibold text-[var(--text-secondary)]">
            拆分 {index + 1}
          </legend>
          <IconButton
            label={`删除拆分 ${index + 1}`}
            variant="ghost-danger"
            className="absolute top-0 right-0 size-6 disabled:opacity-30"
            disabled={drafts.length <= minimumSplits}
            onClick={() => removeDraft(draft.clientId)}
          >
            <Trash aria-hidden className="size-3.5" />
          </IconButton>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[120px_1fr]">
            <Field label="金额">
              <Input
                inputMode="decimal"
                placeholder="0.00"
                className="num text-right"
                value={draft.amount}
                onChange={(event) => update(index, { amount: event.target.value.replace(/[^0-9.]/g, '') })}
              />
            </Field>
            <Field label="描述">
              <Input
                placeholder="这一笔花在哪"
                value={draft.description}
                onChange={(event) => update(index, { description: event.target.value })}
              />
            </Field>
          </div>

          <div className={ROW}>
            {groupType === 'deposit' ? (
              <Field label="来源/付款方">
                <Input
                  placeholder="谁付的钱"
                  value={draft.sourceName}
                  onChange={(event) => update(index, { sourceName: event.target.value })}
                />
              </Field>
            ) : (
              <Field label="来源账户">
                <AccountCombobox
                  accounts={assetAccounts}
                  text={sourceTextOf(draft, assetAccounts)}
                  isLoading={accounts.isLoading}
                  onChange={(text, sourceId) => update(index, { sourceName: text, sourceId })}
                />
              </Field>
            )}
            {groupType === 'withdrawal' ? (
              <Field label="商家/收款方">
                <Input
                  placeholder="钱给了谁"
                  value={draft.destinationName}
                  onChange={(event) => update(index, { destinationName: event.target.value })}
                />
              </Field>
            ) : (
              <Field label="目标账户">
                <AccountCombobox
                  accounts={assetAccounts}
                  text={destinationTextOf(draft, assetAccounts)}
                  isLoading={accounts.isLoading}
                  onChange={(text, destinationId) => update(index, { destinationName: text, destinationId })}
                />
              </Field>
            )}
          </div>

          <div className={ROW}>
            <Field label="日期">
              <DatePicker value={draft.date} onChange={(date) => update(index, { date })} />
            </Field>
            <Field label="分类">
              <CategoryPicker
                value={draft.category || null}
                onChange={(name) => update(index, { category: name ?? '', categoryId: undefined })}
                domains={DOMAINS_BY_TX_TYPE[groupType]}
              />
            </Field>
          </div>

          <div className={ROW}>
            <Field label="预算">
              <Select
                value={draft.budgetId ?? ''}
                onChange={(event) => {
                  const budget = activeBudgets.find((item) => item.id === event.target.value)
                  update(index, { budgetId: budget?.id, budgetName: budget?.attributes.name })
                }}
              >
                <option value="">不使用预算</option>
                {activeBudgets.map((item) => <option key={item.id} value={item.id}>{item.attributes.name}</option>)}
              </Select>
            </Field>
            <Field label="标签" hint="多个标签用逗号分隔">
              <Input
                placeholder="如：报销, 出差"
                value={draft.tags.join(', ')}
                onChange={(event) => update(index, { tags: event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean) })}
              />
            </Field>
          </div>

          <Field label="备注">
            <Textarea rows={2} className="resize-y" value={draft.notes} onChange={(event) => update(index, { notes: event.target.value })} />
          </Field>
        </fieldset>
      ))}

      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" className="text-[var(--brand-text)]" onClick={addDraft}>
          <Plus aria-hidden className="size-3.5" />
          添加拆分
        </Button>
        <Button variant="primary" size="md" disabled={pending || drafts.length < minimumSplits} onClick={() => void save()}>
          {pending ? '保存中…' : groupId ? '保存全部拆分' : '创建多拆分交易'}
        </Button>
      </div>
    </div>
  )
}

/**
 * 账户输入框里该显示什么。草稿里存的名字优先；只有 id 没有名字的（从既有交易读进来的
 * 那一版拆分）用 id 去账户列表里反查，否则改一条老拆分时账户格是空的，看着像没填。
 */
function sourceTextOf(draft: Draft, accounts: Array<{ id: string; name: string }>): string {
  return draft.sourceName || accounts.find((a) => a.id === draft.sourceId)?.name || ''
}

function destinationTextOf(draft: Draft, accounts: Array<{ id: string; name: string }>): string {
  return draft.destinationName || accounts.find((a) => a.id === draft.destinationId)?.name || ''
}
