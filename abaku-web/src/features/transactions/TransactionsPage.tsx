import { useMemo, useState } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { BanknotesIcon, ChevronLeftIcon, ChevronRightIcon, MagnifyingGlassIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { usePageRange } from '../../store/dateRangeStore'
import {
  useAssetAccounts,
  useBudgets,
  useBulkEditTransactions,
  useCategories,
  useDeleteTransaction,
  useSearchTransactionsPage,
  useTags,
} from '../../api/queries'
import type { UpdateTransactionInput } from '../../api/firefly'
import type { TransactionSplit } from '../../api/schemas'
import { buildFireflyQuery, type TxFilters } from '../../lib/fireflyQuery'
import { DataTable } from '../../components/data/DataTable'
import { transactionColumns } from '../../components/data/transactionColumns'
import { DeleteTransactionDialog } from '../../components/abaku/DeleteTransactionDialog'
import { EmptyState } from '../../components/abaku/EmptyState'
import { ErrorState } from '../../components/abaku/ErrorState'
import { Skeleton } from '../../components/abaku/Skeleton'
import { Modal } from '../../components/abaku/Modal'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { Tabs } from '../../components/ui/Tabs'
import { CONTROL_COMPACT, Field, Input, Select } from '../../components/ui/Field'
import { showToast } from '../../store/toastStore'
import { FireflyApiError } from '../../api/client'
import { isEditableTransactionType } from '../record-transaction/editPayload'
import {
  flattenTransactionGroups,
  signedSplitAmount,
  type TransactionSplitRow,
} from '../../lib/transactionGroup'
import { absoluteDecimalString, compareDecimalStrings, sumDecimalStrings } from '../../lib/decimal'
import { formatAmount, formatDayGroupLabel } from '../../lib/format'
import { TransactionDetailModal } from './TransactionDetailModal'

const PAGE_SIZE = 50
const TABS: { label: string; value: 'all' | 'withdrawal' | 'deposit' | 'transfer' }[] = [
  { label: '全部', value: 'all' },
  { label: '支出', value: 'withdrawal' },
  { label: '收入', value: 'deposit' },
  { label: '转账', value: 'transfer' },
]
type BatchKind = 'category' | 'budget' | 'tags'

/** 「清除筛选」要把每个筛选参数都显式置空——漏一个就会留下看不见的过滤条件 */
const CLEARED_FILTERS = {
  q: undefined,
  acc: undefined,
  cat: undefined,
  tag: undefined,
  min: undefined,
  max: undefined,
  type: undefined,
  page: 1,
} as const

const rowKey = (row: TransactionSplitRow) => row.groupId

/** 从已加载的拆分构造可 PUT 的完整负载，并套用批量覆盖项（无覆盖则保持原值）。 */
function splitToUpdateInput(
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

function DayGroupLabel({ day, rows }: { day: string; rows: TransactionSplitRow[] }) {
  const subtotalGroups = new Map<string, { symbol: string; values: string[] }>()
  for (const row of rows) {
    const key = String((row.tx as typeof row.tx & { currency_code?: string }).currency_code ?? '') || row.tx.currency_symbol
    const current = subtotalGroups.get(key)
    if (current) current.values.push(signedSplitAmount(row.tx))
    else subtotalGroups.set(key, { symbol: row.tx.currency_symbol, values: [signedSplitAmount(row.tx)] })
  }
  return (
    <span className="flex w-full items-center justify-between">
      <span>{formatDayGroupLabel(day)}</span>
      <span className="font-mono tabular-nums flex gap-2">
        {Array.from(subtotalGroups.values(), ({ symbol, values }) => {
          const amount = sumDecimalStrings(values)
          const comparison = compareDecimalStrings(amount, '0')
          return (
            <span
              key={`${symbol}-${amount}`}
              className={
                comparison > 0
                  ? 'text-[var(--income)]'
                  : comparison < 0
                    ? 'text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)]'
              }
            >
              {comparison > 0 ? '+' : comparison < 0 ? '-' : ''}
              {symbol}
              {formatAmount(absoluteDecimalString(amount))}
            </span>
          )
        })}
      </span>
    </span>
  )
}

export function TransactionsPage() {
  const search = useSearch({ from: '/transactions' })
  const navigate = useNavigate({ from: '/transactions' })
  const range = usePageRange('transactions')
  const [pendingDelete, setPendingDelete] = useState<TransactionSplitRow | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [batchOpen, setBatchOpen] = useState<BatchKind | null>(null)
  const [batchValue, setBatchValue] = useState('')
  const detailGroupId = search.transaction == null ? null : String(search.transaction)

  const filters: TxFilters = useMemo(
    () => ({
      q: search.q,
      accountIds: search.acc.length > 0 ? search.acc : undefined,
      categories: search.cat.length > 0 ? search.cat : undefined,
      tags: search.tag.length > 0 ? search.tag : undefined,
      amountMin: search.min,
      amountMax: search.max,
      types: search.type ? [search.type] : undefined,
      start: range.start,
      end: range.end,
    }),
    [search, range],
  )

  const query = useSearchTransactionsPage(buildFireflyQuery(filters), { limit: PAGE_SIZE, page: search.page })
  const deleteMutation = useDeleteTransaction()
  const bulkMutation = useBulkEditTransactions()
  const accountsQuery = useAssetAccounts({ includeLiabilities: false })
  const categoriesQuery = useCategories()
  const tagsQuery = useTags()
  const budgetsQuery = useBudgets(range)

  const loaded = useMemo(() => flattenTransactionGroups(query.data?.data ?? []), [query.data])
  const pagination = query.data?.meta?.pagination
  const totalPages = pagination?.total_pages ?? 1
  const currentPage = pagination?.current_page ?? search.page
  const total = pagination?.total ?? query.data?.data.length ?? 0
  const pendingDeleteSplits = pendingDelete
    ? loaded.filter((row) => row.groupId === pendingDelete.groupId).map((row) => row.tx)
    : []

  const rowsByDay = useMemo(() => {
    const map = new Map<string, TransactionSplitRow[]>()
    for (const row of loaded) {
      const day = row.tx.date.slice(0, 10)
      const arr = map.get(day)
      if (arr) arr.push(row)
      else map.set(day, [row])
    }
    return map
  }, [loaded])

  function patchSearch(next: Record<string, unknown>) {
    void navigate({ search: (prev) => ({ ...prev, ...next }), replace: true })
  }

  function openDetail(groupId: string) {
    patchSearch({ transaction: Number(groupId) })
  }

  function toggleSelected(groupId: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }

  async function applyBatch() {
    if (!batchOpen || selected.size === 0) return
    const rowsByGroup = new Map<string, TransactionSplitRow>()
    for (const row of loaded) {
      if (selected.has(row.groupId) && row.splitIndex === 0 && isEditableTransactionType(row.tx.type)) {
        rowsByGroup.set(row.groupId, row)
      }
    }
    const updates = Array.from(rowsByGroup.values(), (row) => {
      const overrides =
        batchOpen === 'category'
          ? { categoryName: batchValue.trim() || null }
          : batchOpen === 'budget'
            ? { budgetId: batchValue || null }
            : { tags: batchValue.split(/[,，]/).map((s) => s.trim()).filter(Boolean) }
      return { groupId: row.groupId, input: splitToUpdateInput(row.tx, overrides) }
    })
    if (updates.length === 0) {
      showToast({ kind: 'error', message: '选中的交易不可编辑' })
      return
    }
    try {
      await bulkMutation.mutateAsync(updates)
      showToast({ kind: 'success', message: `已更新 ${updates.length} 笔交易` })
      setSelected(new Set())
      setBatchOpen(null)
      setBatchValue('')
    } catch (err) {
      const message = err instanceof FireflyApiError || err instanceof Error ? err.message : '批量更新失败'
      showToast({ kind: 'error', message, duration: 6000 })
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return
    try {
      await deleteMutation.mutateAsync(pendingDelete.groupId)
      showToast({ kind: 'success', message: '交易已移入回收站' })
      setPendingDelete(null)
    } catch (err) {
      const message = err instanceof FireflyApiError ? err.message : '移入回收站失败，请重试'
      showToast({ kind: 'error', message, duration: 6000 })
    }
  }

  const hasFilters = !!(search.q || search.acc.length || search.cat.length || search.tag.length || search.min != null || search.max != null || search.type)
  const activeFilters: { key: string; label: string; clear: Record<string, unknown> }[] = []
  if (search.q) activeFilters.push({ key: 'q', label: `关键词：${search.q}`, clear: { q: undefined, page: 1 } })
  if (search.acc.length > 0) {
    const names = search.acc.map((id) => accountsQuery.data?.find((account) => account.id === id)?.name ?? id)
    activeFilters.push({ key: 'acc', label: `账户：${names.join('、')}`, clear: { acc: undefined, page: 1 } })
  }
  if (search.cat.length > 0) activeFilters.push({ key: 'cat', label: `分类：${search.cat.join('、')}`, clear: { cat: undefined, page: 1 } })
  if (search.tag.length > 0) activeFilters.push({ key: 'tag', label: `标签：${search.tag.join('、')}`, clear: { tag: undefined, page: 1 } })
  if (search.min != null) activeFilters.push({ key: 'min', label: `金额 ≥ ${search.min}`, clear: { min: undefined, page: 1 } })
  if (search.max != null) activeFilters.push({ key: 'max', label: `金额 ≤ ${search.max}`, clear: { max: undefined, page: 1 } })
  if (search.type) {
    activeFilters.push({
      key: 'type',
      label: `类型：${TABS.find((tab) => tab.value === search.type)?.label ?? search.type}`,
      clear: { type: undefined, page: 1 },
    })
  }
  const batchLabel =
    batchOpen === 'category' ? '改分类' : batchOpen === 'budget' ? '改预算' : batchOpen === 'tags' ? '加标签' : ''

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-lg font-semibold text-[var(--text-primary)]">交易</h1>
        {!query.isLoading && (
          <span className="text-xs text-[var(--text-secondary)]">
            共 <span className="font-mono tabular-nums text-[var(--text-primary)]">{total}</span> 笔
          </span>
        )}
      </div>

      <Tabs
        aria-label="交易类型"
        tabs={TABS.map((tab) => ({ value: tab.value, label: tab.label }))}
        value={search.type ?? 'all'}
        onChange={(value) => patchSearch({ type: value === 'all' ? undefined : value, page: 1 })}
      />

      <Card padded={false} className="flex flex-wrap items-center gap-2 p-2">
        <div className="relative min-w-[180px] flex-1">
          <MagnifyingGlassIcon
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-[var(--text-tertiary)]"
          />
          <input
            value={search.q ?? ''}
            onChange={(e) => patchSearch({ q: e.target.value || undefined, page: 1 })}
            placeholder="关键词"
            aria-label="关键词"
            className={`${CONTROL_COMPACT} w-full pl-7`}
          />
        </div>
        <select
          value={search.acc[0] ?? ''}
          onChange={(e) => patchSearch({ acc: e.target.value ? [e.target.value] : undefined, page: 1 })}
          aria-label="账户"
          className={`${CONTROL_COMPACT} w-auto`}
        >
          <option value="">全部账户</option>
          {(accountsQuery.data ?? []).map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
        <select
          value={search.cat[0] ?? ''}
          onChange={(e) => patchSearch({ cat: e.target.value ? [e.target.value] : undefined, page: 1 })}
          aria-label="分类"
          className={`${CONTROL_COMPACT} w-auto`}
        >
          <option value="">全部分类</option>
          {(categoriesQuery.data?.data ?? []).map((c) => (
            <option key={c.id} value={c.attributes.name}>{c.attributes.name}</option>
          ))}
        </select>
        <select
          value={search.tag[0] ?? ''}
          onChange={(e) => patchSearch({ tag: e.target.value ? [e.target.value] : undefined, page: 1 })}
          aria-label="标签"
          className={`${CONTROL_COMPACT} w-auto`}
        >
          <option value="">全部标签</option>
          {(tagsQuery.data?.data ?? []).map((t) => (
            <option key={t.id} value={t.attributes.tag}>{t.attributes.tag}</option>
          ))}
        </select>
        <input
          inputMode="decimal"
          value={search.min ?? ''}
          onChange={(e) => patchSearch({ min: e.target.value === '' ? undefined : Number(e.target.value), page: 1 })}
          placeholder="金额 ≥"
          aria-label="最小金额"
          className={`${CONTROL_COMPACT} w-24 font-mono tabular-nums`}
        />
        <input
          inputMode="decimal"
          value={search.max ?? ''}
          onChange={(e) => patchSearch({ max: e.target.value === '' ? undefined : Number(e.target.value), page: 1 })}
          placeholder="金额 ≤"
          aria-label="最大金额"
          className={`${CONTROL_COMPACT} w-24 font-mono tabular-nums`}
        />
        {hasFilters && (
          <Button variant="ghost-danger" size="sm" onClick={() => patchSearch(CLEARED_FILTERS)}>
            清除筛选
          </Button>
        )}
      </Card>

      {activeFilters.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="当前筛选">
          {activeFilters.map((filter) => (
            <button
              key={filter.key}
              type="button"
              aria-label={`移除筛选：${filter.label}`}
              title={`移除筛选：${filter.label}`}
              onClick={() => patchSearch(filter.clear)}
              className="inline-flex max-w-full items-center gap-1 rounded-md bg-[var(--surface-selected)] px-2 py-1 text-xs text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover)]"
            >
              <span className="truncate">{filter.label}</span>
              <XMarkIcon aria-hidden className="size-3.5 shrink-0 text-[var(--text-secondary)]" />
            </button>
          ))}
        </div>
      )}

      {selected.size > 0 && (
        // 批量操作条：说清「已选几笔」再给动作，取消选择推到最右，
        // 免得跟三个修改动作挤在一起被误点
        <Card padded={false} className="flex flex-wrap items-center gap-2 p-2">
          <span className="px-2 text-sm text-[var(--text-secondary)]">已选 {selected.size} 笔</span>
          <Button size="sm" onClick={() => { setBatchOpen('category'); setBatchValue('') }}>改分类</Button>
          <Button size="sm" onClick={() => { setBatchOpen('budget'); setBatchValue('') }}>改预算</Button>
          <Button size="sm" onClick={() => { setBatchOpen('tags'); setBatchValue('') }}>加标签</Button>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setSelected(new Set())}>
            取消选择
          </Button>
        </Card>
      )}

      <Card padded={false} className="p-2">
        {query.isLoading ? (
          <div className="flex flex-col gap-1 p-2" role="status" aria-label="交易加载中">
            {Array.from({ length: 10 }).map((_, i) => (
              <Skeleton key={i} className="h-8" />
            ))}
          </div>
        ) : query.isError ? (
          <ErrorState message="交易加载失败" onRetry={() => void query.refetch()} />
        ) : (
          <DataTable
            rows={loaded}
            columns={transactionColumns()}
            rowKey={rowKey}
            groupBy={(row, prev) => {
              const day = row.tx.date.slice(0, 10)
              if (prev && prev.tx.date.slice(0, 10) === day) return null
              return { key: day, label: <DayGroupLabel day={day} rows={rowsByDay.get(day) ?? []} /> }
            }}
            selection={{ selected, onChange: setSelected }}
            onActivate={(row) => openDetail(row.groupId)}
            onAction={(key, row) => {
              if (key === 'x') toggleSelected(row.groupId)
              else if (key === 'c') {
                setSelected(new Set([row.groupId]))
                setBatchOpen('category')
                setBatchValue('')
              } else if (key === 'e') openDetail(row.groupId)
            }}
            emptyState={
              query.isFetching ? (
                <EmptyState statusIcon="loading" message="加载中…" />
              ) : (
                <EmptyState icon={<BanknotesIcon className="size-9 text-[var(--text-tertiary)]" />} message="所选范围内暂无交易" />
              )
            }
          />
        )}

        {totalPages > 1 && (
          <div className="flex items-center justify-between gap-3 border-t border-[var(--border-subtle)] px-3 pt-3">
            <Button
              variant="secondary"
              size="sm"
              disabled={query.isFetching || currentPage <= 1}
              onClick={() => patchSearch({ page: currentPage - 1 })}
            >
              <ChevronLeftIcon aria-hidden className="size-4" />
              上一页
            </Button>
            <span className="font-mono text-xs tabular-nums text-[var(--text-secondary)]">
              {currentPage} / {totalPages}
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={query.isFetching || currentPage >= totalPages}
              onClick={() => patchSearch({ page: currentPage + 1 })}
            >
              下一页
              <ChevronRightIcon aria-hidden className="size-4" />
            </Button>
          </div>
        )}
      </Card>

      <Modal
        open={batchOpen !== null}
        onClose={() => setBatchOpen(null)}
        title={`批量${batchLabel}`}
        footer={
          <>
            {/* 原先这个框只有一个「确认」按钮。破坏性批量操作至少要给一条明确的退路 */}
            <Button variant="secondary" size="md" onClick={() => setBatchOpen(null)}>
              取消
            </Button>
            <Button variant="primary" size="md" disabled={bulkMutation.isPending} onClick={() => void applyBatch()}>
              {bulkMutation.isPending ? '处理中…' : `将修改 ${selected.size} 笔交易`}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-[var(--text-secondary)]">
            将修改 {selected.size} 笔交易的{batchLabel}。此操作不可撤销。
          </p>
          {batchOpen === 'category' && (
            <Field label="分类名称" hint="留空 = 清除这些交易的分类">
              <Input value={batchValue} onChange={(e) => setBatchValue(e.target.value)} list="batch-categories" />
              <datalist id="batch-categories">
                {(categoriesQuery.data?.data ?? []).map((c) => (
                  <option key={c.id} value={c.attributes.name} />
                ))}
              </datalist>
            </Field>
          )}
          {batchOpen === 'budget' && (
            <Field label="预算">
              <Select value={batchValue} onChange={(e) => setBatchValue(e.target.value)}>
                <option value="">不使用预算</option>
                {(budgetsQuery.data?.data ?? []).map((b) => (
                  <option key={b.id} value={b.id}>{b.attributes.name}</option>
                ))}
              </Select>
            </Field>
          )}
          {batchOpen === 'tags' && (
            <Field label="标签" hint="逗号分隔，如：报销, 差旅">
              <Input value={batchValue} onChange={(e) => setBatchValue(e.target.value)} />
            </Field>
          )}
        </div>
      </Modal>

      <DeleteTransactionDialog
        open={!!pendingDelete}
        splits={pendingDeleteSplits}
        pending={deleteMutation.isPending}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
      <TransactionDetailModal
        groupId={detailGroupId}
        onClose={() => void navigate({ search: (prev) => ({ ...prev, transaction: undefined }), replace: true })}
      />
    </div>
  )
}
