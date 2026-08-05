import { useMemo, useState } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { BanknotesIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline'
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
import { Modal } from '../../components/abaku/Modal'
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
              style={{
                color: comparison < 0 ? 'var(--text-primary)' : comparison > 0 ? 'var(--income)' : 'var(--text-secondary)',
              }}
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
  const totalPages = query.data?.meta?.pagination?.total_pages ?? 1
  const canLoadMore = search.page < totalPages
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
  const batchLabel =
    batchOpen === 'category' ? '改分类' : batchOpen === 'budget' ? '改预算' : batchOpen === 'tags' ? '加标签' : ''

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-1 border-b border-[var(--border-subtle)] ">
        {TABS.map((tab) => {
          const active = (search.type ?? 'all') === tab.value
          return (
            <button
              key={tab.value}
              type="button"
              onClick={() => patchSearch({ type: tab.value === 'all' ? undefined : tab.value, page: 1 })}
              className={`-mb-px border-b-2 px-3 py-2 text-[13px] ${
                active
                  ? 'border-[var(--brand)] font-semibold text-[var(--text-primary)] '
                  : 'border-transparent text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-secondary)] '
              }`}
            >
              {tab.label}
            </button>
          )
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-xl bg-[var(--surface-1)] p-2 shadow-sm ring-1 ring-[var(--border-subtle)] ">
        <label className="flex min-w-[180px] flex-1 items-center gap-1.5 rounded-md bg-[var(--surface-hover)] px-2 py-1.5">
          <MagnifyingGlassIcon aria-hidden className="size-4 text-[var(--text-tertiary)]" />
          <input
            value={search.q ?? ''}
            onChange={(e) => patchSearch({ q: e.target.value || undefined, page: 1 })}
            placeholder="关键词"
            aria-label="关键词"
            className="w-full bg-transparent text-[12.5px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)] "
          />
        </label>
        <select
          value={search.acc[0] ?? ''}
          onChange={(e) => patchSearch({ acc: e.target.value ? [e.target.value] : undefined, page: 1 })}
          aria-label="账户"
          className="rounded-md bg-[var(--surface-hover)] px-2 py-1.5 text-[12.5px] text-[var(--text-primary)] outline-none"
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
          className="rounded-md bg-[var(--surface-hover)] px-2 py-1.5 text-[12.5px] text-[var(--text-primary)] outline-none"
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
          className="rounded-md bg-[var(--surface-hover)] px-2 py-1.5 text-[12.5px] text-[var(--text-primary)] outline-none"
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
          className="w-20 rounded-md bg-[var(--surface-hover)] px-2 py-1.5 text-[12.5px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)] "
        />
        <input
          inputMode="decimal"
          value={search.max ?? ''}
          onChange={(e) => patchSearch({ max: e.target.value === '' ? undefined : Number(e.target.value), page: 1 })}
          placeholder="金额 ≤"
          aria-label="最大金额"
          className="w-20 rounded-md bg-[var(--surface-hover)] px-2 py-1.5 text-[12.5px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)] "
        />
        {hasFilters && (
          <button
            type="button"
            onClick={() =>
              patchSearch({ q: undefined, acc: undefined, cat: undefined, tag: undefined, min: undefined, max: undefined, type: undefined, page: 1 })
            }
            className="rounded-md px-2 py-1.5 text-[12px] text-[var(--danger)] hover:bg-[var(--danger-soft)] "
          >
            清除筛选
          </button>
        )}
      </div>

      {selected.size > 0 && (
        <div className="flex items-center gap-2 rounded-xl bg-[var(--surface-1)] p-2 shadow-sm ring-1 ring-[var(--border-subtle)] ">
          <span className="px-2 text-[12.5px] text-[var(--text-secondary)] ">已选 {selected.size} 笔</span>
          <button type="button" onClick={() => { setBatchOpen('category'); setBatchValue('') }} className="rounded-md bg-[var(--surface-hover)] px-2.5 py-1.5 text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--surface-selected)] ">
            改分类
          </button>
          <button type="button" onClick={() => { setBatchOpen('budget'); setBatchValue('') }} className="rounded-md bg-[var(--surface-hover)] px-2.5 py-1.5 text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--surface-selected)] ">
            改预算
          </button>
          <button type="button" onClick={() => { setBatchOpen('tags'); setBatchValue('') }} className="rounded-md bg-[var(--surface-hover)] px-2.5 py-1.5 text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--surface-selected)] ">
            加标签
          </button>
          <button type="button" onClick={() => setSelected(new Set())} className="ml-auto rounded-md px-2 py-1.5 text-[12.5px] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] ">
            取消选择
          </button>
        </div>
      )}

      <div className="rounded-xl bg-[var(--surface-1)] p-2 shadow-sm ring-1 ring-[var(--border-subtle)] ">
        {query.isLoading ? (
          <div className="flex flex-col gap-1 p-2">
            {Array.from({ length: 10 }).map((_, i) => (
              <div key={i} className="h-8 animate-pulse rounded bg-[var(--surface-hover)] " />
            ))}
          </div>
        ) : query.isError ? (
          <div className="flex flex-col items-center gap-2 py-8 text-[13px] text-[var(--danger)] ">
            <span>交易加载失败</span>
            <button type="button" onClick={() => void query.refetch()} className="text-[var(--brand)] ">
              重试
            </button>
          </div>
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

        {canLoadMore && (
          <div className="flex justify-center p-3">
            <button
              type="button"
              disabled={query.isFetching}
              onClick={() => patchSearch({ page: search.page + 1 })}
              className="rounded-md bg-[var(--surface-hover)] px-3 py-1.5 text-[13px] text-[var(--text-primary)] hover:bg-[var(--surface-selected)] disabled:opacity-60 "
            >
              {query.isFetching ? '加载中…' : '加载更多'}
            </button>
          </div>
        )}
      </div>

      <Modal
        open={batchOpen !== null}
        onClose={() => setBatchOpen(null)}
        title={`批量${batchLabel}`}
        footer={
          <button
            type="button"
            disabled={bulkMutation.isPending}
            onClick={() => void applyBatch()}
            className="rounded-md bg-[var(--brand)] px-3 py-1.5 text-[13px] font-semibold text-[var(--brand-on)] hover:bg-[var(--brand-hover)] disabled:opacity-50"
          >
            {bulkMutation.isPending ? '处理中…' : `将修改 ${selected.size} 笔交易`}
          </button>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-[12.5px] text-[var(--text-secondary)] ">
            将修改 {selected.size} 笔交易的{batchLabel}。此操作不可撤销。
          </p>
          {batchOpen === 'category' && (
            <>
              <input
                value={batchValue}
                onChange={(e) => setBatchValue(e.target.value)}
                placeholder="分类名称（留空 = 清除分类）"
                aria-label="分类名称"
                list="batch-categories"
                className="rounded-md bg-[var(--surface-hover)] px-2.5 py-2 text-[13px] text-[var(--text-primary)] outline-none"
              />
              <datalist id="batch-categories">
                {(categoriesQuery.data?.data ?? []).map((c) => (
                  <option key={c.id} value={c.attributes.name} />
                ))}
              </datalist>
            </>
          )}
          {batchOpen === 'budget' && (
            <select
              value={batchValue}
              onChange={(e) => setBatchValue(e.target.value)}
              aria-label="预算"
              className="rounded-md bg-[var(--surface-hover)] px-2.5 py-2 text-[13px] text-[var(--text-primary)] outline-none"
            >
              <option value="">不使用预算</option>
              {(budgetsQuery.data?.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>{b.attributes.name}</option>
              ))}
            </select>
          )}
          {batchOpen === 'tags' && (
            <input
              value={batchValue}
              onChange={(e) => setBatchValue(e.target.value)}
              placeholder="标签，逗号分隔（如：报销, 差旅）"
              aria-label="标签"
              className="rounded-md bg-[var(--surface-hover)] px-2.5 py-2 text-[13px] text-[var(--text-primary)] outline-none"
            />
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
