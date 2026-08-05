import { useEffect, useRef, useState } from 'react'
import { PlusIcon, TrashIcon } from '@heroicons/react/24/outline'
import {
  useAssetAccounts,
  useBills,
  useBudgets,
  useCreateTransactionSplits,
  useCurrencies,
  useTransaction,
  useUpdateTransactionSplits,
} from '../../api/queries'
import type { CreateTransactionInput, CreateTransactionType, UpdateTransactionInput } from '../../api/firefly'
import { FireflyApiError } from '../../api/client'
import { showToast } from '../../store/toastStore'
import { isPositiveDecimal, normalizeDecimalString } from '../../lib/decimal'
import { toDateInputValue } from '../../lib/format'
import { useDateRangeStore } from '../../store/dateRangeStore'

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
  currencyId?: string
  currencyCode?: string
  foreignCurrencyId?: string
  foreignCurrencyCode?: string
  foreignAmount?: string
  budgetId?: string
  budgetName?: string
  categoryId?: string
  billId?: string
  billName?: string
}

const inputStyle = { background: 'var(--g-surface-2)', color: 'var(--g-ink)', border: '1px solid var(--g-border)' } as const

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
    currencyId: template?.currencyId,
    currencyCode: template?.currencyCode,
    foreignCurrencyId: undefined,
    foreignCurrencyCode: undefined,
    foreignAmount: undefined,
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
  const bills = useBills()
  const currencies = useCurrencies()
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
        currencyId: split.currency_id == null ? undefined : String(split.currency_id),
        currencyCode: split.currency_code ?? undefined,
        foreignCurrencyId: split.foreign_currency_id == null ? undefined : String(split.foreign_currency_id),
        foreignCurrencyCode: split.foreign_currency_code ?? undefined,
        foreignAmount: split.foreign_amount == null ? undefined : normalizeDecimalString(split.foreign_amount),
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
    setDrafts((current) => current.map((draft) => ({
      ...draft,
      sourceId: type === 'deposit' || !assetIds.has(draft.sourceId) ? '' : draft.sourceId,
      sourceName: type === 'deposit' && groupType !== 'deposit' ? '' : draft.sourceName,
      destinationId: type === 'withdrawal' || !assetIds.has(draft.destinationId) ? '' : draft.destinationId,
      destinationName: type === 'withdrawal' && groupType !== 'withdrawal' ? '' : draft.destinationName,
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
      if (draft.foreignAmount) {
        try {
          if (!isPositiveDecimal(draft.foreignAmount)) throw new Error('invalid amount')
        } catch {
          showToast({ kind: 'error', message: '外币金额必须大于 0' })
          return
        }
        if (!draft.foreignCurrencyId && !draft.foreignCurrencyCode) {
          showToast({ kind: 'error', message: '填写外币金额时必须选择外币' })
          return
        }
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
      currency_id: draft.currencyId,
      currency_code: draft.currencyCode,
      foreign_currency_id: draft.foreignCurrencyId ?? null,
      foreign_currency_code: draft.foreignCurrencyCode,
      foreign_amount: draft.foreignAmount ? normalizeDecimalString(draft.foreignAmount) : null,
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
      showToast({ kind: 'error', message: error instanceof FireflyApiError ? error.message : groupId ? '多拆分交易更新失败' : '多拆分交易创建失败', duration: 6000 })
    }
  }

  if (groupId && query.isLoading) return <div className="py-6 text-center text-[12px] text-gray-500 dark:text-gray-400">加载交易详情…</div>
  if (groupId && query.isError) return <div className="flex items-center justify-between py-4 text-[12px] text-red-600 dark:text-red-400"><span>交易详情加载失败</span><button type="button" onClick={() => void query.refetch()} style={{ color: 'var(--g-accent)' }}>重试</button></div>

  const pending = mutation.isPending || createMutation.isPending
  const minimumSplits = groupId ? 1 : 2

  return <div className="flex flex-col gap-3">
    <div className="flex gap-1" role="tablist" aria-label="拆分交易类型">{(['withdrawal', 'deposit', 'transfer'] as const).map((type) => <button key={type} type="button" role="tab" aria-selected={groupType === type} onClick={() => changeType(type)} className="flex-1 rounded-[5px] px-2 py-1.5 text-[12px]" style={{ background: groupType === type ? 'var(--g-accent)' : 'var(--g-surface-2)', color: groupType === type ? 'var(--g-accent-ink)' : 'var(--g-ink-2)' }}>{type === 'withdrawal' ? '支出' : type === 'deposit' ? '收入' : '转账'}</button>)}</div>
    <input aria-label="交易组标题" value={groupTitle} onChange={(event) => { setGroupTitle(event.target.value); onDirtyChange(true) }} placeholder="默认使用第一条拆分描述" className="rounded-[5px] px-2 py-1.5" style={inputStyle} />
    {drafts.map((draft, index) => <section key={draft.clientId} className="flex flex-col gap-2 border-b pb-3 border-gray-200 dark:border-gray-700">
      <div className="flex items-center justify-between"><span className="font-num text-[11px] text-gray-500 dark:text-gray-400">拆分 {index + 1}</span><button type="button" title="删除拆分" aria-label={`删除拆分 ${index + 1}`} disabled={drafts.length <= minimumSplits} onClick={() => removeDraft(draft.clientId)} className="rounded p-1 disabled:opacity-30 text-red-600 dark:text-red-400"><TrashIcon aria-hidden className="size-3.5" /></button></div>
      <div className="grid grid-cols-[120px_1fr] gap-2"><input inputMode="decimal" aria-label={`拆分 ${index + 1} 金额`} value={draft.amount} onChange={(event) => update(index, { amount: event.target.value.replace(/[^0-9.]/g, '') })} className="font-num rounded-[5px] px-2 py-1.5 text-right" style={inputStyle} /><input aria-label={`拆分 ${index + 1} 描述`} value={draft.description} onChange={(event) => update(index, { description: event.target.value })} className="rounded-[5px] px-2 py-1.5" style={inputStyle} /></div>
      <div className="grid grid-cols-2 gap-2">
        {groupType === 'deposit' ? <input aria-label={`拆分 ${index + 1} 来源`} value={draft.sourceName} onChange={(event) => update(index, { sourceName: event.target.value })} placeholder="收入来源" className="rounded-[5px] px-2 py-1.5" style={inputStyle} /> : <AccountSelect label={`拆分 ${index + 1} 来源账户`} value={draft.sourceId} accounts={accounts.data ?? []} onChange={(sourceId) => update(index, { sourceId })} />}
        {groupType === 'withdrawal' ? <input aria-label={`拆分 ${index + 1} 目标`} value={draft.destinationName} onChange={(event) => update(index, { destinationName: event.target.value })} placeholder="商家/用途" className="rounded-[5px] px-2 py-1.5" style={inputStyle} /> : <AccountSelect label={`拆分 ${index + 1} 目标账户`} value={draft.destinationId} accounts={accounts.data ?? []} onChange={(destinationId) => update(index, { destinationId })} />}
      </div>
      <div className="grid grid-cols-2 gap-2"><input type="date" aria-label={`拆分 ${index + 1} 日期`} value={draft.date} onChange={(event) => update(index, { date: event.target.value })} className="font-num rounded-[5px] px-2 py-1.5" style={inputStyle} /><select aria-label={`拆分 ${index + 1} 币种`} value={draft.currencyId ?? ''} onChange={(event) => { const currency = currencies.data?.data.find((item) => item.id === event.target.value); update(index, { currencyId: currency?.id, currencyCode: currency?.attributes.code }) }} className="rounded-[5px] px-2 py-1.5" style={inputStyle}><option value="">沿用账户币种</option>{(currencies.data?.data ?? []).filter((item) => item.attributes.enabled !== false).map((item) => <option key={item.id} value={item.id}>{item.attributes.code} · {item.attributes.name}</option>)}</select></div>
      <div className="grid grid-cols-2 gap-2"><input aria-label={`拆分 ${index + 1} 分类`} value={draft.category} onChange={(event) => update(index, { category: event.target.value, categoryId: undefined })} placeholder="分类" className="rounded-[5px] px-2 py-1.5" style={inputStyle} /><select aria-label={`拆分 ${index + 1} 预算`} value={draft.budgetId ?? ''} onChange={(event) => { const budget = budgets.data?.data.find((item) => item.id === event.target.value); update(index, { budgetId: budget?.id, budgetName: budget?.attributes.name }) }} className="rounded-[5px] px-2 py-1.5" style={inputStyle}><option value="">不使用预算</option>{(budgets.data?.data ?? []).filter((item) => item.attributes.active !== false).map((item) => <option key={item.id} value={item.id}>{item.attributes.name}</option>)}</select></div>
      <div className="grid grid-cols-2 gap-2"><select aria-label={`拆分 ${index + 1} 账单`} value={draft.billId ?? ''} onChange={(event) => { const bill = bills.data?.data.find((item) => item.id === event.target.value); update(index, { billId: bill?.id, billName: bill?.attributes.name }) }} className="rounded-[5px] px-2 py-1.5" style={inputStyle}><option value="">不关联账单</option>{(bills.data?.data ?? []).filter((item) => item.attributes.active !== false).map((item) => <option key={item.id} value={item.id}>{item.attributes.name}</option>)}</select><input aria-label={`拆分 ${index + 1} 标签`} value={draft.tags.join(', ')} onChange={(event) => update(index, { tags: event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean) })} placeholder="标签，逗号分隔" className="rounded-[5px] px-2 py-1.5" style={inputStyle} /></div>
      <div className="grid grid-cols-2 gap-2"><select aria-label={`拆分 ${index + 1} 外币`} value={draft.foreignCurrencyId ?? ''} onChange={(event) => { const currency = currencies.data?.data.find((item) => item.id === event.target.value); update(index, { foreignCurrencyId: currency?.id, foreignCurrencyCode: currency?.attributes.code, foreignAmount: currency ? draft.foreignAmount : '' }) }} className="rounded-[5px] px-2 py-1.5" style={inputStyle}><option value="">无外币金额</option>{(currencies.data?.data ?? []).filter((item) => item.attributes.enabled !== false && item.id !== draft.currencyId).map((item) => <option key={item.id} value={item.id}>{item.attributes.code} · {item.attributes.name}</option>)}</select><input inputMode="decimal" aria-label={`拆分 ${index + 1} 外币金额`} disabled={!draft.foreignCurrencyId} value={draft.foreignAmount ?? ''} onChange={(event) => update(index, { foreignAmount: event.target.value.replace(/[^0-9.]/g, '') })} placeholder="外币金额" className="font-num rounded-[5px] px-2 py-1.5 disabled:opacity-50" style={inputStyle} /></div>
      <textarea aria-label={`拆分 ${index + 1} 备注`} rows={2} value={draft.notes} onChange={(event) => update(index, { notes: event.target.value })} placeholder="备注" className="resize-y rounded-[5px] px-2 py-1.5" style={inputStyle} />
    </section>)}
    <div className="flex items-center justify-between"><button type="button" onClick={addDraft} className="flex items-center gap-1 rounded-[5px] px-2 py-1.5 text-[12px] text-indigo-600 dark:text-indigo-400"><PlusIcon aria-hidden className="size-3.5" />添加拆分</button><button type="button" disabled={pending || drafts.length < minimumSplits} onClick={() => void save()} className="rounded-[6px] px-3 py-1.5 text-[12.5px] disabled:opacity-50 bg-indigo-600 text-white font-semibold shadow-sm hover:bg-indigo-500">{pending ? '保存中…' : groupId ? '保存全部拆分' : '创建多拆分交易'}</button></div>
  </div>
}

function AccountSelect({ label, value, accounts, onChange }: { label: string; value: string; accounts: Array<{ id: string; name: string }>; onChange: (id: string) => void }) {
  return <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} className="rounded-[5px] px-2 py-1.5" style={inputStyle}><option value="">选择账户…</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select>
}
