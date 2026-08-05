import { useEffect, useMemo, useState } from 'react'
import { AdjustmentsHorizontalIcon, PencilIcon, PlusIcon, TrashIcon } from '@heroicons/react/24/outline'
import type { Budget } from '../../api/schemas'
import type { DateRange } from '../../api/firefly'
import { useCreateBudgetLimit, useCurrencies, useDeleteBudget, useUpdateBudget, useUpdateBudgetLimit } from '../../api/queries'
import { ProgressBar } from '../../components/granary/ProgressBar'
import { Modal } from '../../components/granary/Modal'
import { formatAmount } from '../../lib/format'
import { absoluteDecimalString, compareDecimalStrings, decimalPercentage, isPositiveDecimal, normalizeDecimalString, sumDecimalStrings } from '../../lib/decimal'
import { showToast } from '../../store/toastStore'
import { FireflyApiError } from '../../api/client'
import type { BudgetLimitInfo } from './useBudgetsData'

const inputStyle = { background: 'var(--g-surface-2)', color: 'var(--g-ink)', border: '1px solid var(--g-border)' } as const

export function BudgetRow({ budget, limits, range, limitsLoading = false, limitsError = false, onRetryLimits }: { budget: Budget; limits: BudgetLimitInfo[]; range: DateRange; limitsLoading?: boolean; limitsError?: boolean; onRetryLimits?: () => void }) {
  const attrs = budget.attributes
  const [limitsOpen, setLimitsOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [editName, setEditName] = useState(attrs.name)
  const [editActive, setEditActive] = useState(attrs.active !== false)
  const [drafts, setDrafts] = useState<Record<string, { amount: string; start: string; end: string }>>({})
  const [newAmount, setNewAmount] = useState('')
  const [newStart, setNewStart] = useState(range.start)
  const [newEnd, setNewEnd] = useState(range.end)
  const [newCurrencyCode, setNewCurrencyCode] = useState('')
  const updateMutation = useUpdateBudgetLimit()
  const createMutation = useCreateBudgetLimit()
  const updateBudgetMutation = useUpdateBudget()
  const deleteBudgetMutation = useDeleteBudget()
  const currenciesQuery = useCurrencies()

  const currencySummaries = useMemo(() => {
    const groups = new Map<string, { code: string; symbol: string; spent: string[]; limits: string[] }>()
    const getGroup = (code: string, symbol: string) => {
      const key = code || symbol || 'unknown'
      let group = groups.get(key)
      if (!group) {
        group = { code, symbol: symbol || code, spent: [], limits: [] }
        groups.set(key, group)
      }
      return group
    }
    for (const entry of attrs.spent ?? []) {
      const code = entry.currency_code ?? attrs.currency_code ?? attrs.primary_currency_code ?? ''
      const symbol = entry.currency_symbol ?? attrs.currency_symbol ?? attrs.primary_currency_symbol ?? code
      getGroup(code, symbol).spent.push(absoluteDecimalString(entry.sum))
    }
    for (const limit of limits) {
      const code = limit.code ?? attrs.currency_code ?? attrs.primary_currency_code ?? ''
      const symbol = limit.symbol ?? attrs.currency_symbol ?? attrs.primary_currency_symbol ?? code
      getGroup(code, symbol).limits.push(limit.amount)
    }
    if (groups.size === 0) {
      const code = attrs.currency_code ?? attrs.primary_currency_code ?? ''
      getGroup(code, attrs.currency_symbol ?? attrs.primary_currency_symbol ?? code)
    }
    return Array.from(groups.values(), (group) => {
      const spent = sumDecimalStrings(group.spent.length > 0 ? group.spent : ['0'])
      const total = sumDecimalStrings(group.limits.length > 0 ? group.limits : ['0'])
      const hasLimit = group.limits.length > 0 && compareDecimalStrings(total, '0') > 0
      return {
        ...group,
        spent,
        total,
        hasLimit,
        over: hasLimit && compareDecimalStrings(spent, total) > 0,
        pct: hasLimit ? decimalPercentage(spent, total) : 0,
      }
    })
  }, [attrs, limits])

  useEffect(() => {
    if (!limitsOpen) return
    setDrafts(Object.fromEntries(limits.map((limit) => [limit.limitId, { amount: limit.amount, start: limit.start, end: limit.end }])))
    setNewStart(range.start)
    setNewEnd(range.end)
    setNewAmount('')
    const currencies = currenciesQuery.data?.data ?? []
    const preferred = attrs.currency_code ?? limits[0]?.code
      ?? currencies.find((currency) => currency.attributes.default && currency.attributes.enabled !== false)?.attributes.code
      ?? currencies.find((currency) => currency.attributes.enabled !== false)?.attributes.code
      ?? ''
    setNewCurrencyCode(preferred)
  }, [limitsOpen, limits, range.start, range.end, attrs.currency_code, currenciesQuery.data])

  function openEdit() {
    setEditName(attrs.name)
    setEditActive(attrs.active !== false)
    setEditOpen(true)
  }

  async function saveBudget() {
    if (!editName.trim()) {
      showToast({ kind: 'error', message: '预算名称不能为空' })
      return
    }
    try {
      await updateBudgetMutation.mutateAsync({ budgetId: budget.id, input: { name: editName.trim(), active: editActive } })
      setEditOpen(false)
      showToast({ kind: 'success', message: '预算已更新' })
    } catch (error) {
      showToast({ kind: 'error', message: error instanceof FireflyApiError ? error.message : '预算更新失败' })
    }
  }

  async function removeBudget() {
    if (!window.confirm(`删除预算“${attrs.name}”？交易不会删除，但会失去预算关联。`)) return
    try {
      await deleteBudgetMutation.mutateAsync(budget.id)
      setEditOpen(false)
      showToast({ kind: 'success', message: '预算已删除' })
    } catch (error) {
      showToast({ kind: 'error', message: error instanceof FireflyApiError ? error.message : '预算删除失败' })
    }
  }

  async function update(limit: BudgetLimitInfo) {
    const draft = drafts[limit.limitId]
    try {
      if (!draft || !isPositiveDecimal(draft.amount) || !draft.start || !draft.end || draft.start > draft.end) {
        showToast({ kind: 'error', message: '请填写有效日期范围和正金额' })
        return
      }
    } catch {
      showToast({ kind: 'error', message: '请填写有效日期范围和正金额' })
      return
    }
    try {
      await updateMutation.mutateAsync({ budgetId: budget.id, limitId: limit.limitId, input: { amount: normalizeDecimalString(draft.amount), start: draft.start, end: draft.end } })
      showToast({ kind: 'success', message: '限额已更新' })
    } catch (error) {
      showToast({ kind: 'error', message: error instanceof FireflyApiError ? error.message : '限额更新失败' })
    }
  }

  async function create() {
    let validAmount = false
    try {
      validAmount = isPositiveDecimal(newAmount)
    } catch {
      validAmount = false
    }
    if (!validAmount || !newStart || !newEnd || newStart > newEnd || !newCurrencyCode) {
      showToast({ kind: 'error', message: '请填写有效日期范围和正金额' })
      return
    }
    try {
      await createMutation.mutateAsync({ budgetId: budget.id, input: { start: newStart, end: newEnd, amount: normalizeDecimalString(newAmount), currency_code: newCurrencyCode } })
      setNewAmount('')
      showToast({ kind: 'success', message: '限额已添加' })
    } catch (error) {
      showToast({ kind: 'error', message: error instanceof FireflyApiError ? error.message : '限额添加失败' })
    }
  }

  const rangeLabel = useMemo(() => limits.length === 1 ? `${limits[0].start} 至 ${limits[0].end}` : `${limits.length} 个重叠限额`, [limits])

  return <>
    <div className="group flex min-h-8 flex-wrap items-center gap-2 rounded-[4px] px-2 py-1 text-[12.5px] hover:bg-[var(--g-surface-2)] sm:flex-nowrap sm:gap-3">
      <div className="min-w-0 flex-1 truncate text-gray-900 dark:text-gray-100">{attrs.name}</div>
      {limitsLoading ? <div className="order-2 w-full text-left text-[11px] sm:order-none sm:w-[350px] sm:text-right text-gray-500 dark:text-gray-400">限额加载中…</div> : limitsError ? <div className="order-2 flex w-full items-center gap-2 text-[11px] sm:order-none sm:w-[350px] sm:justify-end text-red-600 dark:text-red-400"><span>限额加载失败</span><button type="button" onClick={onRetryLimits} style={{ color: 'var(--g-accent)' }}>重试</button></div> : <div className="order-2 flex w-full shrink-0 flex-col gap-1 sm:order-none sm:w-[350px]">{currencySummaries.map((summary) => <div key={summary.code || summary.symbol} className="flex min-w-0 items-center gap-3"><div className="flex min-w-[90px] flex-1 items-center sm:w-[150px] sm:flex-none">{summary.hasLimit ? <ProgressBar pct={summary.pct} colorVar={summary.over ? 'var(--g-danger)' : 'var(--g-accent)'} /> : <span className="text-[11px] text-gray-500 dark:text-gray-400">未设限额</span>}</div><div className="font-num min-w-0 flex-1 text-right sm:w-[187px] sm:flex-none" title={summary.code} style={{ color: summary.over ? 'var(--g-danger)' : 'var(--g-ink)' }}>{summary.symbol}{formatAmount(summary.spent)}{summary.hasLimit && <span style={{ color: 'var(--g-ink-2)' }}> / {summary.symbol}{formatAmount(summary.total)}</span>}</div></div>)}</div>}
      <button type="button" title="管理限额" aria-label={`管理 ${attrs.name} 的限额`} disabled={limitsLoading || limitsError} onClick={() => setLimitsOpen(true)} className="rounded p-1 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100 disabled:opacity-20 text-gray-500 dark:text-gray-400"><AdjustmentsHorizontalIcon aria-hidden className="size-3.5" /></button>
      <button type="button" title="编辑预算" aria-label={`编辑预算 ${attrs.name}`} onClick={openEdit} className="rounded p-1 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100 text-gray-500 dark:text-gray-400"><PencilIcon aria-hidden className="size-3.5" /></button>
    </div>
    <Modal open={limitsOpen} onClose={() => setLimitsOpen(false)} title={`${attrs.name} · 限额`} width={620} footer={<button type="button" onClick={() => setLimitsOpen(false)} className="rounded-[6px] px-3 py-1.5 text-[12.5px] bg-gray-100 text-gray-900 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700">完成</button>}>
      <div className="flex flex-col gap-3">
        {limits.map((limit, index) => <div key={limit.limitId} className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_1fr_110px_60px]"><label className="flex min-w-0 flex-col gap-1 text-[11px] text-gray-500 dark:text-gray-400">开始<input type="date" aria-label={`限额 ${index + 1} 开始`} value={drafts[limit.limitId]?.start ?? ''} onChange={(event) => setDrafts((current) => ({ ...current, [limit.limitId]: { ...current[limit.limitId], start: event.target.value } }))} className="font-num min-w-0 rounded-[5px] px-2 py-1.5" style={inputStyle} /></label><label className="flex min-w-0 flex-col gap-1 text-[11px] text-gray-500 dark:text-gray-400">结束<input type="date" aria-label={`限额 ${index + 1} 结束`} value={drafts[limit.limitId]?.end ?? ''} onChange={(event) => setDrafts((current) => ({ ...current, [limit.limitId]: { ...current[limit.limitId], end: event.target.value } }))} className="font-num min-w-0 rounded-[5px] px-2 py-1.5" style={inputStyle} /></label><label className="flex min-w-0 flex-col gap-1 text-[11px] text-gray-500 dark:text-gray-400">金额<input inputMode="decimal" aria-label={`限额 ${index + 1} 金额`} value={drafts[limit.limitId]?.amount ?? ''} onChange={(event) => setDrafts((current) => ({ ...current, [limit.limitId]: { ...current[limit.limitId], amount: event.target.value.replace(/[^0-9.]/g, '') } }))} className="font-num min-w-0 rounded-[5px] px-2 py-1.5 text-right" style={inputStyle} /></label><button type="button" aria-label={`保存限额 ${index + 1}`} disabled={updateMutation.isPending} onClick={() => void update(limit)} className="justify-self-end rounded-[5px] px-2 py-1.5 text-[11.5px] disabled:opacity-50 text-indigo-600 dark:text-indigo-400">保存</button></div>)}
        {limits.length > 0 && <div className="text-[11px] text-gray-500 dark:text-gray-400">{rangeLabel}</div>}
        <div className="grid grid-cols-1 items-end gap-2 border-t pt-3 sm:grid-cols-[1fr_1fr_90px_110px_32px] border-gray-200 dark:border-gray-700"><label className="flex min-w-0 flex-col gap-1 text-[11px] text-gray-500 dark:text-gray-400">新限额开始<input type="date" value={newStart} onChange={(event) => setNewStart(event.target.value)} className="font-num min-w-0 rounded-[5px] px-2 py-1.5" style={inputStyle} /></label><label className="flex min-w-0 flex-col gap-1 text-[11px] text-gray-500 dark:text-gray-400">结束<input type="date" value={newEnd} onChange={(event) => setNewEnd(event.target.value)} className="font-num min-w-0 rounded-[5px] px-2 py-1.5" style={inputStyle} /></label><label className="flex min-w-0 flex-col gap-1 text-[11px] text-gray-500 dark:text-gray-400">币种<select value={newCurrencyCode} onChange={(event) => setNewCurrencyCode(event.target.value)} className="min-w-0 rounded-[5px] px-2 py-1.5" style={inputStyle}>{(currenciesQuery.data?.data ?? []).filter((currency) => currency.attributes.enabled !== false).map((currency) => <option key={currency.id} value={currency.attributes.code}>{currency.attributes.code}</option>)}</select></label><label className="flex min-w-0 flex-col gap-1 text-[11px] text-gray-500 dark:text-gray-400">金额<input inputMode="decimal" value={newAmount} onChange={(event) => setNewAmount(event.target.value.replace(/[^0-9.]/g, ''))} className="font-num min-w-0 rounded-[5px] px-2 py-1.5 text-right" style={inputStyle} /></label><button type="button" title="添加限额" aria-label="添加限额" disabled={createMutation.isPending} onClick={() => void create()} className="justify-self-end rounded p-1.5 disabled:opacity-50 text-indigo-600 dark:text-indigo-400"><PlusIcon aria-hidden className="size-4" /></button></div>
      </div>
    </Modal>
    <Modal open={editOpen} onClose={() => setEditOpen(false)} title="编辑预算" width={420} footer={<>
      <button type="button" title="删除预算" aria-label={`删除预算 ${attrs.name}`} disabled={deleteBudgetMutation.isPending} onClick={() => void removeBudget()} className="mr-auto rounded p-1.5 disabled:opacity-50 text-red-600 dark:text-red-400"><TrashIcon aria-hidden className="size-4" /></button>
      <button type="button" disabled={updateBudgetMutation.isPending} onClick={() => setEditOpen(false)} className="rounded-[6px] px-3 py-1.5 text-[12px] text-gray-500 dark:text-gray-400">取消</button>
      <button type="button" disabled={updateBudgetMutation.isPending} onClick={() => void saveBudget()} className="rounded-[6px] px-3 py-1.5 text-[12px] disabled:opacity-50 bg-indigo-600 text-white font-semibold shadow-sm hover:bg-indigo-500">{updateBudgetMutation.isPending ? '保存中…' : '保存'}</button>
    </>}>
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-[12px] text-gray-500 dark:text-gray-400">名称<input autoFocus value={editName} onChange={(event) => setEditName(event.target.value)} className="rounded-[6px] px-2.5 py-1.5" style={inputStyle} /></label>
        <label className="flex items-center gap-2 text-[12px] text-gray-900 dark:text-gray-100"><input type="checkbox" checked={editActive} onChange={(event) => setEditActive(event.target.checked)} />启用预算</label>
      </div>
    </Modal>
  </>
}
