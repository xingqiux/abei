import { useEffect, useMemo, useState } from 'react'
import { Faders, PencilSimple, Plus, Trash } from '@phosphor-icons/react'
import type { Budget } from '../../api/schemas'
import type { DateRange } from '../../api/firefly'
import { useCreateBudgetLimit, useCurrencies, useDeleteBudget, useUpdateBudget, useUpdateBudgetLimit } from '../../api/queries'
import { ProgressBar } from '../../components/abei/ProgressBar'
import { ConfirmDialog } from '../../components/abei/ConfirmDialog'
import { Modal } from '../../components/abei/Modal'
import { InlineError } from '../../components/abei/ErrorState'
import { Button, IconButton } from '../../components/ui/Button'
import { Field, Input, Select } from '../../components/ui/Field'
import { formatAmount } from '../../lib/format'
import { absoluteDecimalString, compareDecimalStrings, decimalPercentage, isPositiveDecimal, normalizeDecimalString, sumDecimalStrings } from '../../lib/decimal'
import { showToast } from '../../store/toastStore'
import { AbeiApiError } from '../../api/client'
import type { BudgetLimitInfo } from './useBudgetsData'

export function BudgetRow({ budget, limits, range, limitsLoading = false, limitsError, onRetryLimits }: { budget: Budget; limits: BudgetLimitInfo[]; range: DateRange; limitsLoading?: boolean; /** 错误对象本身，不是布尔：InlineError 靠它按 reason 分情形说话 */ limitsError?: unknown; onRetryLimits?: () => void }) {
  const attrs = budget.attributes
  const [limitsOpen, setLimitsOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
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
      showToast({ kind: 'error', message: error instanceof AbeiApiError ? error.message : '预算更新失败' })
    }
  }

  async function removeBudget() {
    try {
      await deleteBudgetMutation.mutateAsync(budget.id)
      setDeleteOpen(false)
      setEditOpen(false)
      showToast({ kind: 'success', message: '预算已删除' })
    } catch (error) {
      showToast({ kind: 'error', message: error instanceof AbeiApiError ? error.message : '预算删除失败' })
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
      showToast({ kind: 'error', message: error instanceof AbeiApiError ? error.message : '限额更新失败' })
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
      showToast({ kind: 'error', message: error instanceof AbeiApiError ? error.message : '限额添加失败' })
    }
  }

  const rangeLabel = useMemo(() => limits.length === 1 ? `${limits[0].start} 至 ${limits[0].end}` : `${limits.length} 个重叠限额`, [limits])

  function patchDraft(limitId: string, patch: Partial<{ amount: string; start: string; end: string }>) {
    setDrafts((current) => ({ ...current, [limitId]: { ...current[limitId], ...patch } }))
  }

  return (
    <>
      <div className="group flex min-h-8 flex-wrap items-center gap-2 rounded px-2 py-1 text-[12.5px] hover:bg-[var(--surface-hover)] sm:flex-nowrap sm:gap-3">
        <div className="min-w-0 flex-1 truncate text-[var(--text-primary)]">{attrs.name}</div>

        {limitsLoading ? (
          <div
            role="status"
            className="order-2 w-full text-left text-[11px] text-[var(--text-secondary)] sm:order-none sm:w-[350px] sm:text-right"
          >
            限额加载中…
          </div>
        ) : limitsError ? (
          <div className="order-2 w-full sm:order-none sm:w-[350px]">
            <InlineError message="限额加载失败" error={limitsError} onRetry={onRetryLimits} />
          </div>
        ) : (
          <div className="order-2 flex w-full shrink-0 flex-col gap-1 sm:order-none sm:w-[350px]">
            {currencySummaries.map((summary) => (
              <div key={summary.code || summary.symbol} className="flex min-w-0 items-center gap-3">
                <div className="flex min-w-[90px] flex-1 items-center sm:w-[150px] sm:flex-none">
                  {summary.hasLimit ? (
                    <ProgressBar
                      pct={summary.pct}
                      tone={summary.over ? 'danger' : 'brand'}
                      label={`${budget.attributes.name}${summary.code ? ` · ${summary.code}` : ''} 已用`}
                    />
                  ) : (
                    <span className="text-[11px] text-[var(--text-secondary)]">未设限额</span>
                  )}
                </div>
                <div
                  title={summary.code}
                  className={`min-w-0 flex-1 text-right font-mono tabular-nums sm:w-[187px] sm:flex-none ${
                    summary.over ? 'text-[var(--danger)]' : 'text-[var(--text-primary)]'
                  }`}
                >
                  {summary.symbol}{formatAmount(summary.spent)}
                  {summary.hasLimit && (
                    <span className="text-[var(--text-secondary)]"> / {summary.symbol}{formatAmount(summary.total)}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* 桌面上悬停才显形，移动端一直在——触屏没有 hover，藏起来等于没有 */}
        <IconButton
          label={`管理 ${attrs.name} 的限额`}
          className="size-6 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
          disabled={limitsLoading || Boolean(limitsError)}
          onClick={() => setLimitsOpen(true)}
        >
          <Faders aria-hidden className="size-3.5" />
        </IconButton>
        <IconButton
          label={`编辑预算 ${attrs.name}`}
          className="size-6 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
          onClick={openEdit}
        >
          <PencilSimple aria-hidden className="size-3.5" />
        </IconButton>
      </div>

      <Modal
        open={limitsOpen}
        onClose={() => setLimitsOpen(false)}
        title={`${attrs.name} · 限额`}
        width={620}
        footer={<Button variant="secondary" size="md" onClick={() => setLimitsOpen(false)}>完成</Button>}
      >
        <div className="flex flex-col gap-3">
          {limits.map((limit, index) => (
            <div key={limit.limitId} className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_1fr_110px_60px]">
              <Field label="开始">
                <Input
                  type="date"
                  aria-label={`限额 ${index + 1} 开始`}
                  className="font-mono tabular-nums"
                  value={drafts[limit.limitId]?.start ?? ''}
                  max={drafts[limit.limitId]?.end}
                  onChange={(event) => patchDraft(limit.limitId, { start: event.target.value })}
                />
              </Field>
              <Field label="结束">
                <Input
                  type="date"
                  aria-label={`限额 ${index + 1} 结束`}
                  className="font-mono tabular-nums"
                  value={drafts[limit.limitId]?.end ?? ''}
                  min={drafts[limit.limitId]?.start}
                  onChange={(event) => patchDraft(limit.limitId, { end: event.target.value })}
                />
              </Field>
              <Field label="金额">
                <Input
                  inputMode="decimal"
                  aria-label={`限额 ${index + 1} 金额`}
                  className="text-right font-mono tabular-nums"
                  value={drafts[limit.limitId]?.amount ?? ''}
                  onChange={(event) => patchDraft(limit.limitId, { amount: event.target.value.replace(/[^0-9.]/g, '') })}
                />
              </Field>
              <Button
                variant="soft"
                size="sm"
                aria-label={`保存限额 ${index + 1}`}
                disabled={updateMutation.isPending}
                onClick={() => void update(limit)}
              >
                保存
              </Button>
            </div>
          ))}

          {limits.length > 0 && <div className="text-[11px] text-[var(--text-secondary)]">{rangeLabel}</div>}

          <div className="grid grid-cols-1 items-end gap-2 border-t border-[var(--border-subtle)] pt-3 sm:grid-cols-[1fr_1fr_90px_110px_32px]">
            <Field label="新限额开始">
              <Input type="date" className="font-mono tabular-nums" value={newStart} max={newEnd} onChange={(event) => setNewStart(event.target.value)} />
            </Field>
            <Field label="结束">
              <Input type="date" className="font-mono tabular-nums" value={newEnd} min={newStart} onChange={(event) => setNewEnd(event.target.value)} />
            </Field>
            <Field label="币种">
              <Select value={newCurrencyCode} onChange={(event) => setNewCurrencyCode(event.target.value)}>
                {(currenciesQuery.data?.data ?? [])
                  .filter((currency) => currency.attributes.enabled !== false)
                  .map((currency) => (
                    <option key={currency.id} value={currency.attributes.code}>{currency.attributes.code}</option>
                  ))}
              </Select>
            </Field>
            <Field label="金额">
              <Input
                inputMode="decimal"
                className="text-right font-mono tabular-nums"
                value={newAmount}
                onChange={(event) => setNewAmount(event.target.value.replace(/[^0-9.]/g, ''))}
              />
            </Field>
            <IconButton label="添加限额" variant="soft" disabled={createMutation.isPending} onClick={() => void create()}>
              <Plus aria-hidden className="size-4" />
            </IconButton>
          </div>
        </div>
      </Modal>

      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title="编辑预算"
        width={420}
        footer={
          <>
            <IconButton
              label={`删除预算 ${attrs.name}`}
              variant="ghost-danger"
              className="mr-auto"
              disabled={deleteBudgetMutation.isPending}
              onClick={() => setDeleteOpen(true)}
            >
              <Trash aria-hidden className="size-4" />
            </IconButton>
            <Button variant="secondary" size="md" disabled={updateBudgetMutation.isPending} onClick={() => setEditOpen(false)}>
              取消
            </Button>
            <Button variant="primary" size="md" disabled={updateBudgetMutation.isPending} onClick={() => void saveBudget()}>
              {updateBudgetMutation.isPending ? '保存中…' : '保存'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="名称" error={editName.trim() ? undefined : '预算名称不能为空'}>
            <Input autoFocus value={editName} onChange={(event) => setEditName(event.target.value)} />
          </Field>
          <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
            <input
              type="checkbox"
              className="accent-[var(--brand)]"
              checked={editActive}
              onChange={(event) => setEditActive(event.target.checked)}
            />
            启用预算
          </label>
        </div>
      </Modal>

      <ConfirmDialog
        open={deleteOpen}
        title="删除预算"
        confirmLabel="删除预算"
        pending={deleteBudgetMutation.isPending}
        onConfirm={() => void removeBudget()}
        onClose={() => setDeleteOpen(false)}
      >
        <p>
          确定删除预算「<span className="font-semibold text-[var(--text-primary)]">{attrs.name}</span>」？
          交易不会被删除，但与该预算的关联将丢失。此操作不可撤销。
        </p>
      </ConfirmDialog>
    </>
  )
}
