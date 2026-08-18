import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { CaretDown, Funnel, MagnifyingGlass, Money, Sparkle, X } from '@phosphor-icons/react'
import { usePageRange } from '../../store/dateRangeStore'
import {
  useAssetAccounts,
  useBackfillSuggestions,
  useBudgets,
  useBulkEditTransactions,
  useCategories,
  useDeleteTransaction,
  useInfiniteSearchTransactions,
  useResolveBackfillSuggestion,
  useRunBackfill,
  useSearchTransactionsPage,
  useSummaryBasic,
  useTags,
  useUpdateTransaction,
} from '../../api/queries'
import type { BackfillSuggestion, TransactionSplit } from '../../api/schemas'
import { CategoryPicker } from '../../components/abei/CategoryPicker'
import { buildFireflyQuery, type TxFilters } from '../../lib/fireflyQuery'
import { DataTable } from '../../components/data/DataTable'
import { transactionColumns } from '../../components/data/transactionColumns'
import { DeleteTransactionDialog } from '../../components/abei/DeleteTransactionDialog'
import { EmptyState } from '../../components/abei/EmptyState'
import { ErrorState } from '../../components/abei/ErrorState'
import { Skeleton } from '../../components/abei/Skeleton'
import { Modal } from '../../components/abei/Modal'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { Tabs } from '../../components/ui/Tabs'
import { SegmentedControl } from '../../components/ui/SegmentedControl'
import { CONTROL_COMPACT, Field, Input, Select } from '../../components/ui/Field'
import { showToast } from '../../store/toastStore'
import { useRecordTxStore } from '../../store/recordTxStore'
import { useMediaQuery, XL_UP } from '../../hooks/useMediaQuery'
import { AbeiApiError } from '../../api/client'
import { isEditableTransactionType } from '../record-transaction/editPayload'
import { flattenTransactionGroups, type TransactionSplitRow } from '../../lib/transactionGroup'
import { sumByCurrency } from '../../lib/dayTotals'
import { absoluteDecimalString, compareDecimalStrings } from '../../lib/decimal'
import { formatAmount, formatDayGroupLabel, formatSignedAmount } from '../../lib/format'
import { summaryAmounts, cashflowAmounts, type CurrencyAmount } from '../../lib/summary'
import { TransactionDetailModal } from './TransactionDetailModal'
import { TransactionSidePanel } from './TransactionSidePanel'
import { parseTags, splitToUpdateInput } from './updateInput'

const PAGE_SIZE = 50
const TABS: { label: string; value: 'all' | 'withdrawal' | 'deposit' | 'transfer' }[] = [
  { label: '全部', value: 'all' },
  { label: '支出', value: 'withdrawal' },
  { label: '收入', value: 'deposit' },
  { label: '转账', value: 'transfer' },
]
type BatchKind = 'category' | 'budget' | 'tags'

const GROUP_MODES = [
  { value: 'day', label: '按日' },
  { value: 'category', label: '按分类' },
  { value: 'account', label: '按账户' },
] as const
type GroupMode = (typeof GROUP_MODES)[number]['value']

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

/** 付款/收款账户：支出看来源，收入看目标。分组用的键要跟列里显示的一致 */
function fundingNameOf(row: TransactionSplitRow): string {
  const tx = row.tx
  const name = tx.type === 'deposit' ? tx.destination_name : tx.source_name
  return (name ?? '').trim() || '未记录账户'
}

function groupKeyOf(row: TransactionSplitRow, mode: GroupMode): string {
  if (mode === 'day') return row.tx.date.slice(0, 10)
  if (mode === 'category') return row.tx.category_name?.trim() || '未分类'
  return fundingNameOf(row)
}

/** 一组的合计，按币种分开列——不同币种直接相加是错的 */
function GroupTotals({ rows }: { rows: TransactionSplitRow[] }) {
  return (
    <span className="num flex gap-2">
      {sumByCurrency(rows).map(({ symbol, amount }) => {
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
  )
}

export function TransactionsPage() {
  const search = useSearch({ from: '/transactions' })
  const navigate = useNavigate({ from: '/transactions' })
  const range = usePageRange('transactions')
  const openRecordForm = useRecordTxStore((s) => s.openForm)
  const wide = useMediaQuery(XL_UP)
  const [pendingDelete, setPendingDelete] = useState<TransactionSplitRow | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [batchOpen, setBatchOpen] = useState<BatchKind | null>(null)
  const [batchValue, setBatchValue] = useState('')
  const [groupMode, setGroupMode] = useState<GroupMode>('day')
  const [filterOpen, setFilterOpen] = useState(false)
  const [paneOpen, setPaneOpen] = useState(true)
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

  const query = useInfiniteSearchTransactions(buildFireflyQuery(filters), { limit: PAGE_SIZE })
  const summaryQuery = useSummaryBasic(range)
  const deleteMutation = useDeleteTransaction()
  const bulkMutation = useBulkEditTransactions()
  const accountsQuery = useAssetAccounts({ includeLiabilities: false })
  const categoriesQuery = useCategories()
  const tagsQuery = useTags()
  const budgetsQuery = useBudgets(range)

  const loaded = useMemo(
    () => (query.data?.pages ?? []).flatMap((page) => flattenTransactionGroups(page.data)),
    [query.data],
  )
  const total = query.data?.pages[0]?.meta?.pagination?.total ?? loaded.length

  /** 分组依据不是「按日」时要先按组的键重排，DataTable 的分组是顺序驱动的 */
  const rows = useMemo(() => {
    if (groupMode === 'day') return loaded
    const buckets = new Map<string, TransactionSplitRow[]>()
    for (const row of loaded) {
      const key = groupKeyOf(row, groupMode)
      const bucket = buckets.get(key)
      if (bucket) bucket.push(row)
      else buckets.set(key, [row])
    }
    return [...buckets.values()].sort((a, b) => b.length - a.length).flat()
  }, [loaded, groupMode])

  const rowsByGroup = useMemo(() => {
    const map = new Map<string, TransactionSplitRow[]>()
    for (const row of rows) {
      const key = groupKeyOf(row, groupMode)
      const bucket = map.get(key)
      if (bucket) bucket.push(row)
      else map.set(key, [row])
    }
    return map
  }, [rows, groupMode])

  /** 同一组里有几条拆分——面板要靠它判断能不能快捷编辑（PUT 是整组替换） */
  const splitCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const row of loaded) map.set(row.groupId, (map.get(row.groupId) ?? 0) + 1)
    return map
  }, [loaded])

  const focusIndex = detailGroupId ? rows.findIndex((row) => row.groupId === detailGroupId) : -1
  const focusRow = focusIndex >= 0 ? rows[focusIndex] : null
  const multi = selected.size > 0
  // 面板位子一直留着：选中一笔才撑出 320px 的话，整张表会跟着抖一下，列还会换一套
  const showPanel = wide && paneOpen
  const showModal = detailGroupId != null && !(showPanel && focusRow != null)

  const uncategorizedLoaded = loaded.filter((row) => !row.tx.category_name).length

  function patchSearch(next: Record<string, unknown>) {
    void navigate({ search: (prev) => ({ ...prev, ...next }), replace: true })
  }

  function openDetail(groupId: string) {
    patchSearch({ transaction: Number(groupId) })
  }

  function focusByOffset(delta: number) {
    if (focusIndex < 0) return
    const next = rows[Math.min(rows.length - 1, Math.max(0, focusIndex + delta))]
    if (next) openDetail(next.groupId)
  }

  function toggleSelected(groupId: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }

  async function applyBatch(kind: BatchKind, value: string) {
    if (selected.size === 0) return
    const rowsByGroupId = new Map<string, TransactionSplitRow>()
    for (const row of loaded) {
      if (selected.has(row.groupId) && row.splitIndex === 0 && isEditableTransactionType(row.tx.type)) {
        rowsByGroupId.set(row.groupId, row)
      }
    }
    const updates = Array.from(rowsByGroupId.values(), (row) => {
      const overrides =
        kind === 'category'
          ? { categoryName: value.trim() || null }
          : kind === 'budget'
            ? { budgetId: value || null }
            : { tags: parseTags(value) }
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
      const message = err instanceof AbeiApiError || err instanceof Error ? err.message : '批量更新失败'
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
      const message = err instanceof AbeiApiError ? err.message : '移入回收站失败，请重试'
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
  /**
   * 从这一页点开「记一笔」时把当前上下文带过去：正看着收入 tab 就默认记收入，
   * 只筛了一个账户就预填那个账户。tab 值本来就是 Firefly 的 type，直接传。
   */
  const recordPreset = {
    type: search.type || undefined,
    sourceAccountId: search.acc.length === 1 ? search.acc[0] : undefined,
  }

  // 未分类回填审阅是另一套界面（AI 建议 + 逐笔确认），跟带筛选的交易列表共用路由但不共用布局
  if (search.view === 'uncategorized') {
    return <UncategorizedReview onExit={() => patchSearch({ view: undefined, page: 1 })} />
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-lg font-semibold text-[var(--text-primary)]">交易</h1>
        <span className="num text-xs text-[var(--text-secondary)]">
          {range.start} ~ {range.end}
        </span>
      </div>

      <Tabs
        aria-label="交易类型"
        tabs={TABS.map((tab) => ({ value: tab.value, label: tab.label }))}
        value={search.type ?? 'all'}
        onChange={(value) => patchSearch({ type: value === 'all' ? undefined : value, page: 1 })}
      />

      <StatStrip
        count={query.isLoading ? null : total}
        spent={summaryQuery.data ? summaryAmounts(summaryQuery.data, 'spent') : []}
        earned={summaryQuery.data ? summaryAmounts(summaryQuery.data, 'earned') : []}
        cashflow={summaryQuery.data ? cashflowAmounts(summaryQuery.data) : []}
        filtered={hasFilters}
      />

      {/* 筛选收起成一个按钮：六个控件常年不用却一直占地方，关键词框留在外面 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[180px] flex-1 sm:max-w-[280px] sm:flex-none">
          <MagnifyingGlass
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-[var(--text-tertiary)]"
          />
          <input
            value={search.q ?? ''}
            onChange={(e) => patchSearch({ q: e.target.value || undefined, page: 1 })}
            placeholder="搜描述、账户"
            aria-label="关键词"
            className={`${CONTROL_COMPACT} w-full pl-7`}
          />
        </div>

        <div className="relative">
          <Button
            variant="secondary"
            size="sm"
            aria-expanded={filterOpen}
            onClick={() => setFilterOpen((open) => !open)}
          >
            <Funnel aria-hidden className="size-4" />
            筛选
            {activeFilters.length > 0 && <span className="num">{activeFilters.length}</span>}
            <CaretDown aria-hidden className="size-3.5" />
          </Button>
          {filterOpen && (
            <div
              className="absolute top-full left-0 z-30 mt-1 flex w-[280px] flex-col gap-2.5 rounded-lg bg-[var(--surface-1)] p-3 shadow-[var(--shadow-pop)] ring-1 ring-[var(--ring-card)]"
              onMouseLeave={() => setFilterOpen(false)}
            >
              <Field label="账户">
                <Select
                  value={search.acc[0] ?? ''}
                  onChange={(e) => patchSearch({ acc: e.target.value ? [e.target.value] : undefined, page: 1 })}
                >
                  <option value="">全部账户</option>
                  {(accountsQuery.data ?? []).map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </Select>
              </Field>
              <Field label="分类">
                <Select
                  value={search.cat[0] ?? ''}
                  onChange={(e) => patchSearch({ cat: e.target.value ? [e.target.value] : undefined, page: 1 })}
                >
                  <option value="">全部分类</option>
                  {(categoriesQuery.data?.data ?? []).map((c) => (
                    <option key={c.id} value={c.attributes.name}>{c.attributes.name}</option>
                  ))}
                </Select>
              </Field>
              <Field label="标签">
                <Select
                  value={search.tag[0] ?? ''}
                  onChange={(e) => patchSearch({ tag: e.target.value ? [e.target.value] : undefined, page: 1 })}
                >
                  <option value="">全部标签</option>
                  {(tagsQuery.data?.data ?? []).map((t) => (
                    <option key={t.id} value={t.attributes.tag}>{t.attributes.tag}</option>
                  ))}
                </Select>
              </Field>
              <div className="flex gap-2">
                <Field label="金额 ≥">
                  <Input
                    inputMode="decimal"
                    className="num"
                    value={search.min ?? ''}
                    onChange={(e) => patchSearch({ min: e.target.value === '' ? undefined : Number(e.target.value), page: 1 })}
                  />
                </Field>
                <Field label="金额 ≤">
                  <Input
                    inputMode="decimal"
                    className="num"
                    value={search.max ?? ''}
                    onChange={(e) => patchSearch({ max: e.target.value === '' ? undefined : Number(e.target.value), page: 1 })}
                  />
                </Field>
              </div>
              <div className="flex justify-end gap-2">
                {hasFilters && (
                  <Button variant="ghost-danger" size="sm" onClick={() => patchSearch(CLEARED_FILTERS)}>
                    清除筛选
                  </Button>
                )}
                <Button variant="secondary" size="sm" onClick={() => setFilterOpen(false)}>
                  收起
                </Button>
              </div>
            </div>
          )}
        </div>

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
            <X aria-hidden className="size-3.5 shrink-0 text-[var(--text-secondary)]" />
          </button>
        ))}

        <div className="ml-auto flex items-center gap-2">
          <SegmentedControl
            segments={GROUP_MODES}
            value={groupMode}
            onChange={setGroupMode}
            aria-label="分组依据"
          />
          <Button
            variant="ghost"
            size="sm"
            className="hidden xl:inline-flex"
            aria-pressed={paneOpen}
            onClick={() => setPaneOpen((open) => !open)}
          >
            {paneOpen ? '收起面板' : '展开面板'}
          </Button>
        </div>
      </div>

      {/* 未分类不逐行重复：说在列表上方，说一次，并且直接给动作 */}
      {uncategorizedLoaded > 0 && (
        <div
          className="flex flex-wrap items-center gap-2.5 rounded-lg px-3 py-2 text-[12.5px] text-[var(--text-primary)]"
          style={{ background: 'var(--brand-soft)' }}
        >
          <Sparkle aria-hidden weight="fill" className="size-4 shrink-0 text-[var(--brand-text)]" />
          <span>
            已加载 <span className="num font-semibold">{loaded.length}</span> 笔，其中{' '}
            <span className="num font-semibold">{uncategorizedLoaded}</span> 笔未分类
          </span>
          <button
            type="button"
            className="ml-auto text-[12.5px] font-medium text-[var(--brand-text)] underline-offset-2 hover:underline"
            onClick={() => patchSearch({ view: 'uncategorized', page: 1 })}
          >
            AI 归类
          </button>
        </div>
      )}

      {/* 面板收起（或窄屏）时，批量动作还是走这条 */}
      {multi && !showPanel && (
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

      <div
        className={`grid items-start gap-3 ${showPanel ? 'grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px]' : 'grid-cols-1'}`}
      >
        <Card padded={false} className="min-w-0 p-2">
          {query.isLoading ? (
            <div className="flex flex-col gap-1 p-2" role="status" aria-label="交易加载中">
              {Array.from({ length: 10 }).map((_, i) => (
                <Skeleton key={i} className="h-8" />
              ))}
            </div>
          ) : query.isError ? (
            <ErrorState message="交易加载失败" error={query.error} onRetry={() => void query.refetch()} />
          ) : (
            <>
              <DataTable
                rows={rows}
                columns={transactionColumns({
                  showDate: groupMode !== 'day',
                  showCategory: true,
                  showAccount: !showPanel,
                })}
                rowKey={rowKey}
                showHeader
                groupBy={(row, prev) => {
                  const key = groupKeyOf(row, groupMode)
                  if (prev && groupKeyOf(prev, groupMode) === key) return null
                  const groupRows = rowsByGroup.get(key) ?? []
                  return {
                    key,
                    label: (
                      <span className="flex w-full items-center justify-between gap-2">
                        <span className="truncate">
                          {groupMode === 'day' ? formatDayGroupLabel(key) : key}
                          <span className="num ml-2 text-[var(--text-tertiary)]">{groupRows.length} 笔</span>
                        </span>
                        <GroupTotals rows={groupRows} />
                      </span>
                    ),
                  }
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
                    <EmptyState
                      statusIcon="loading"
                      message="加载中…"
                      action={{ label: '记一笔', onClick: () => openRecordForm(recordPreset) }}
                    />
                  ) : (
                    <EmptyState
                      icon={<Money className="size-9 text-[var(--text-tertiary)]" />}
                      message={hasFilters ? '当前筛选条件下没有交易' : '所选范围内暂无交易'}
                      action={
                        hasFilters
                          ? { label: '清除筛选', onClick: () => patchSearch(CLEARED_FILTERS) }
                          : { label: '记一笔', onClick: () => openRecordForm(recordPreset) }
                      }
                    />
                  )
                }
              />

              {rows.length > 0 && (
                <ScrollTail
                  loaded={loaded.length}
                  total={total}
                  hasMore={query.hasNextPage}
                  loading={query.isFetchingNextPage}
                  onMore={() => void query.fetchNextPage()}
                />
              )}
            </>
          )}
        </Card>

        {showPanel && (
          <aside className="sticky top-0 flex min-w-0 flex-col gap-3">
            {multi ? (
              <BatchPanel
                count={selected.size}
                pending={bulkMutation.isPending}
                categories={(categoriesQuery.data?.data ?? []).map((c) => c.attributes.name)}
                budgets={(budgetsQuery.data?.data ?? []).map((b) => ({ id: b.id, name: b.attributes.name }))}
                onApply={(kind, value) => void applyBatch(kind, value)}
                onCancel={() => setSelected(new Set())}
              />
            ) : focusRow ? (
              <TransactionSidePanel
                key={focusRow.groupId}
                row={focusRow}
                splitCount={splitCounts.get(focusRow.groupId) ?? 1}
                selected={selected.has(focusRow.groupId)}
                onToggleSelect={() => toggleSelected(focusRow.groupId)}
                onPrev={() => focusByOffset(-1)}
                onNext={() => focusByOffset(1)}
                onDelete={() => setPendingDelete(focusRow)}
              />
            ) : (
              <Card className="flex flex-col gap-1.5">
                <span className="text-[11px] font-medium tracking-wide text-[var(--text-secondary)] uppercase">
                  单笔详情
                </span>
                <p className="text-[12.5px] text-[var(--text-secondary)]">未选中交易</p>
                <p className="num text-[11px] text-[var(--text-tertiary)]">
                  ↑↓ 选行 · Enter 打开 · 空格 勾选 · E 编辑
                </p>
              </Card>
            )}
          </aside>
        )}
      </div>

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
            <Button
              variant="primary"
              size="md"
              disabled={bulkMutation.isPending}
              onClick={() => batchOpen && void applyBatch(batchOpen, batchValue)}
            >
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
        splits={pendingDelete ? loaded.filter((row) => row.groupId === pendingDelete.groupId).map((row) => row.tx) : []}
        pending={deleteMutation.isPending}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
      <TransactionDetailModal
        groupId={showModal ? detailGroupId : null}
        onClose={() => void navigate({ search: (prev) => ({ ...prev, transaction: undefined }), replace: true })}
      />
    </div>
  )
}

/** 本期概览：原版一个数都没有，只有右上角「共 122 笔」 */
function StatStrip({
  count,
  spent,
  earned,
  cashflow,
  filtered,
}: {
  count: number | null
  spent: CurrencyAmount[]
  earned: CurrencyAmount[]
  cashflow: CurrencyAmount[]
  filtered: boolean
}) {
  return (
    <Card padded={false} className="flex flex-wrap items-center">
      <StatCell label="笔数" text={count == null ? '--' : String(count)} />
      <StatCell label="支出" amounts={spent} semantic="expense" />
      <StatCell label="收入" amounts={earned} semantic="income" />
      <StatCell label="净流" amounts={cashflow} semantic="neutral" last />
      {filtered && (
        <span className="px-3 py-2 text-[11px] text-[var(--text-tertiary)]">金额按日期范围统计，不含筛选</span>
      )}
    </Card>
  )
}

function StatCell({
  label,
  text,
  amounts,
  semantic = 'neutral',
  last = false,
}: {
  label: string
  text?: string
  amounts?: CurrencyAmount[]
  semantic?: 'expense' | 'income' | 'neutral'
  last?: boolean
}) {
  return (
    <div
      className={`flex items-baseline gap-2 px-4 py-2 ${last ? '' : 'border-r border-[var(--border-subtle)]'}`}
    >
      <span className="text-[11px] font-medium tracking-wide text-[var(--text-secondary)] uppercase">{label}</span>
      {text != null ? (
        <span className="num text-[15px] font-semibold text-[var(--text-primary)]">{text}</span>
      ) : amounts && amounts.length > 0 ? (
        amounts.map((amount) => {
          // 零就不带正负号，也不上色——「-¥0.00」看着像出了错
          const comparison = compareDecimalStrings(amount.value, '0')
          const tone =
            comparison === 0
              ? 'text-[var(--text-secondary)]'
              : (semantic === 'income' || (semantic === 'neutral' && comparison > 0))
                ? 'text-[var(--income)]'
                : 'text-[var(--text-primary)]'
          return (
            <span key={amount.code} className={`num text-[15px] font-semibold ${tone}`}>
              {formatSignedAmount(
                amount.value,
                comparison === 0 ? 'neutral' : semantic === 'neutral' ? (comparison > 0 ? 'income' : 'expense') : semantic,
                amount.symbol,
              )}
            </span>
          )
        })
      ) : (
        <span className="num text-[15px] font-semibold text-[var(--text-secondary)]">--</span>
      )}
    </div>
  )
}

/** 滚动加载：到底了就明说，别让人以为还有 */
function ScrollTail({
  loaded,
  total,
  hasMore,
  loading,
  onMore,
}: {
  loaded: number
  total: number
  hasMore: boolean
  loading: boolean
  onMore: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const node = ref.current
    if (!node || !hasMore || loading) return
    // jsdom 里没有 IntersectionObserver，单测不该因为一个「加载更多」哨兵挂掉
    if (typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) onMore()
      },
      { rootMargin: '300px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasMore, loading, onMore])

  return (
    <div ref={ref} className="px-2 py-3 text-center text-[11.5px] text-[var(--text-secondary)]">
      {hasMore ? (
        <button type="button" className="underline-offset-2 hover:underline" onClick={onMore} disabled={loading}>
          {loading ? '加载中…' : `加载更多 · 已显示 ${loaded} / ${total} 笔`}
        </button>
      ) : (
        <span className="num">共 {total} 笔</span>
      )}
    </div>
  )
}

/** 多笔：面板变批量表单，比底部条能装下更多字段 */
function BatchPanel({
  count,
  pending,
  categories,
  budgets,
  onApply,
  onCancel,
}: {
  count: number
  pending: boolean
  categories: string[]
  budgets: { id: string; name: string }[]
  onApply: (kind: BatchKind, value: string) => void
  onCancel: () => void
}) {
  const [kind, setKind] = useState<BatchKind>('category')
  const [value, setValue] = useState('')

  return (
    <Card className="flex flex-col gap-3">
      <div className="text-[15px] font-semibold text-[var(--text-primary)]">已选 {count} 笔</div>
      <SegmentedControl
        segments={[
          { value: 'category', label: '改分类' },
          { value: 'budget', label: '改预算' },
          { value: 'tags', label: '加标签' },
        ]}
        value={kind}
        onChange={(next) => {
          setKind(next)
          setValue('')
        }}
        aria-label="批量操作"
      />
      {kind === 'category' && (
        <Field label="分类名称" hint="留空 = 清除这些交易的分类">
          <Input value={value} onChange={(e) => setValue(e.target.value)} list="panel-categories" />
          <datalist id="panel-categories">
            {categories.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </Field>
      )}
      {kind === 'budget' && (
        <Field label="预算">
          <Select value={value} onChange={(e) => setValue(e.target.value)}>
            <option value="">不使用预算</option>
            {budgets.map((budget) => (
              <option key={budget.id} value={budget.id}>{budget.name}</option>
            ))}
          </Select>
        </Field>
      )}
      {kind === 'tags' && (
        <Field label="标签" hint="逗号分隔，如：报销, 差旅">
          <Input value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
      )}
      <div className="flex items-center gap-2">
        <Button variant="primary" size="sm" className="flex-1" disabled={pending} onClick={() => onApply(kind, value)}>
          {pending ? '处理中…' : `应用到 ${count} 笔`}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          取消
        </Button>
      </div>
      <p className="text-[11px] text-[var(--text-tertiary)]">批量修改不可撤销</p>
    </Card>
  )
}

/** 一次采纳超过这个数就先给清单预览，规矩跟收件箱批量入账一致 */
const BACKFILL_DIRECT_LIMIT = 20

/** 对手方：支出看目标账户，收入看来源账户，都没有就退回描述 */
function counterpartyOf(tx: TransactionSplit): string {
  const name = tx.type === 'deposit' ? tx.source_name : tx.destination_name
  return (name ?? '').trim() || tx.description
}

function SuggestionChip({ suggestion }: { suggestion: BackfillSuggestion }) {
  const from = suggestion.source === 'rule' ? '规则' : '模型'
  return (
    <span
      title={`AI 建议（来自${from}），点采纳才写进去`}
      className="inline-flex items-center gap-1 rounded-md border border-dashed border-[var(--brand-text)] px-1.5 py-0.5 text-[11.5px] text-[var(--brand-text)]"
    >
      {suggestion.category_name}
      <span className="text-[10.5px] text-[var(--text-tertiary)]">{from}</span>
    </span>
  )
}

/**
 * 未分类回填审阅（设计稿 02 §4）：AI 给建议，人逐笔确认。
 * 不受顶部日期范围限制——历史欠的账要一次看全，按月切会永远清不完。
 */
function UncategorizedReview({ onExit }: { onExit: () => void }) {
  const query = useSearchTransactionsPage(buildFireflyQuery({ q: 'has_no_category:true' }), { limit: 100, page: 1 })
  const suggestionsQuery = useBackfillSuggestions()
  const runBackfill = useRunBackfill()
  const resolveSuggestion = useResolveBackfillSuggestion()
  const updateMutation = useUpdateTransaction()
  const bulkMutation = useBulkEditTransactions()

  const [picking, setPicking] = useState<TransactionSplitRow | null>(null)
  const [pickName, setPickName] = useState<string | null>(null)
  const [confirmBatch, setConfirmBatch] = useState(false)
  const [busy, setBusy] = useState(false)

  const rows = useMemo(() => flattenTransactionGroups(query.data?.data ?? []), [query.data])
  const byJournal = useMemo(() => {
    const map = new Map<string, BackfillSuggestion>()
    for (const s of suggestionsQuery.data ?? []) map.set(s.journal_id, s)
    return map
  }, [suggestionsQuery.data])

  const pairs = useMemo(
    () =>
      rows.flatMap((row) => {
        const journalId = row.tx.transaction_journal_id == null ? null : String(row.tx.transaction_journal_id)
        const suggestion = journalId ? byJournal.get(journalId) : undefined
        return suggestion ? [{ row, journalId, suggestion }] : []
      }),
    [rows, byJournal],
  )

  const journalIdOf = (row: TransactionSplitRow) =>
    row.tx.transaction_journal_id == null ? null : String(row.tx.transaction_journal_id)

  function reportError(err: unknown, fallback: string) {
    const message = err instanceof AbeiApiError || err instanceof Error ? err.message : fallback
    showToast({ kind: 'error', message, duration: 6000 })
  }

  /**
   * 写分类 + 记一次「人确认了」。
   * 这里以前还顺手立一条分类规则；规则改由用户自己写进《个人记账规则》文档，
   * 这一步就只剩「把分类写进去」这一件事。
   */
  async function applyOne(row: TransactionSplitRow, name: string) {
    const journalId = journalIdOf(row)
    await updateMutation.mutateAsync({ groupId: row.groupId, input: splitToUpdateInput(row.tx, { categoryName: name }) })
    if (journalId) await resolveSuggestion.mutateAsync({ journalId, applied: true })
  }

  async function accept(row: TransactionSplitRow, name: string) {
    setBusy(true)
    try {
      await applyOne(row, name)
      showToast({ kind: 'success', message: `已归到「${name}」` })
    } catch (err) {
      reportError(err, '写分类失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  async function ignore(row: TransactionSplitRow) {
    const journalId = journalIdOf(row)
    if (!journalId) return
    setBusy(true)
    try {
      await resolveSuggestion.mutateAsync({ journalId, applied: false })
      showToast({ kind: 'success', message: '已忽略这条建议' })
    } catch (err) {
      reportError(err, '忽略失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  async function confirmPick() {
    if (!picking || !pickName) return
    const row = picking
    const name = pickName
    setBusy(true)
    try {
      await applyOne(row, name)
      showToast({ kind: 'success', message: `已归到「${name}」` })
      setPicking(null)
      setPickName(null)
    } catch (err) {
      reportError(err, '写分类失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  async function acceptAll() {
    if (pairs.length === 0) return
    setBusy(true)
    try {
      await bulkMutation.mutateAsync(
        pairs.map(({ row, suggestion }) => ({
          groupId: row.groupId,
          input: splitToUpdateInput(row.tx, { categoryName: suggestion.category_name }),
        })),
      )
      for (const { journalId } of pairs) {
        if (journalId) await resolveSuggestion.mutateAsync({ journalId, applied: true })
      }
      showToast({ kind: 'success', message: `已采纳 ${pairs.length} 条建议` })
      setConfirmBatch(false)
    } catch (err) {
      reportError(err, '批量采纳失败')
    } finally {
      setBusy(false)
    }
  }

  function onAcceptAllClick() {
    if (pairs.length > BACKFILL_DIRECT_LIMIT) setConfirmBatch(true)
    else void acceptAll()
  }

  async function runAi() {
    setBusy(true)
    try {
      const result = await runBackfill.mutateAsync(undefined)
      const count = result.suggestions
      showToast({
        kind: 'success',
        message: count == null ? 'AI 跑完了，刷新看建议' : `AI 给了 ${count} 条建议`,
      })
    } catch (err) {
      reportError(err, '让 AI 出建议失败，请稍后重试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-lg font-semibold text-[var(--text-primary)]">未分类交易</h1>
        <button
          type="button"
          onClick={onExit}
          className="text-xs text-[var(--brand-text)] underline-offset-2 hover:underline"
        >
          回到全部交易
        </button>
      </div>

      <Card padded={false} className="flex flex-wrap items-center gap-2 p-2">
        <span className="px-1 text-[12.5px] text-[var(--text-secondary)]">
          未分类 <span className="num text-[var(--text-primary)]">{rows.length}</span> 笔，其中{' '}
          <span className="num text-[var(--text-primary)]">{pairs.length}</span> 笔有 AI 建议 · 不受日期范围限制
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void runAi()}>
            让 AI 出建议
          </Button>
          <Button size="sm" variant="primary" disabled={busy || pairs.length === 0} onClick={onAcceptAllClick}>
            全部采纳 {pairs.length} 笔
          </Button>
        </div>
      </Card>

      <Card padded={false} className="p-2">
        {query.isLoading ? (
          <div className="flex flex-col gap-1 p-2" role="status" aria-label="交易加载中">
            {Array.from({ length: 10 }).map((_, i) => (
              <Skeleton key={i} className="h-11" />
            ))}
          </div>
        ) : query.isError ? (
          <ErrorState message="交易加载失败" error={query.error} onRetry={() => void query.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState message="没有未分类交易" action={{ label: '回到全部交易', onClick: onExit }} />
        ) : (
          <ul className="flex flex-col">
            {rows.map((row) => {
              const journalId = journalIdOf(row)
              const suggestion = journalId ? byJournal.get(journalId) : undefined
              return (
                <li
                  key={`${row.groupId}-${row.splitIndex}`}
                  className="flex min-h-11 flex-wrap items-center gap-2 rounded-[4px] px-2 py-1.5 text-[12.5px] transition-colors hover:bg-[var(--surface-hover)]"
                >
                  <span className="num w-[76px] shrink-0 text-[var(--text-secondary)]">{row.tx.date.slice(0, 10)}</span>
                  <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">{row.tx.description}</span>
                  <span className="hidden w-[140px] shrink-0 truncate text-[11.5px] text-[var(--text-secondary)] sm:block">
                    {counterpartyOf(row.tx)}
                  </span>
                  <span className="num w-[104px] shrink-0 text-right text-[var(--text-primary)]">
                    {row.tx.currency_symbol}
                    {formatAmount(absoluteDecimalString(row.tx.amount))}
                  </span>
                  <span className="flex w-[150px] shrink-0 justify-end">
                    {suggestion ? <SuggestionChip suggestion={suggestion} /> : (
                      <span className="text-[11.5px] text-[var(--text-tertiary)]">无建议</span>
                    )}
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {suggestion && (
                      <Button size="xs" variant="soft" disabled={busy} onClick={() => void accept(row, suggestion.category_name)}>
                        采纳
                      </Button>
                    )}
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        setPicking(row)
                        setPickName(suggestion?.category_name ?? null)
                      }}
                    >
                      {suggestion ? '换一个' : '选分类'}
                    </Button>
                    {suggestion && (
                      <Button size="xs" variant="ghost" disabled={busy} onClick={() => void ignore(row)}>
                        忽略
                      </Button>
                    )}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      <Modal
        open={picking !== null}
        onClose={() => setPicking(null)}
        title="选个分类"
        footer={
          <>
            <Button variant="secondary" size="md" onClick={() => setPicking(null)}>
              取消
            </Button>
            <Button variant="primary" size="md" disabled={busy || !pickName} onClick={() => void confirmPick()}>
              {busy ? '保存中…' : '写进去'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-[var(--text-secondary)]">
            {picking?.tx.description}
          </p>
          <CategoryPicker value={pickName} onChange={(name) => setPickName(name)} aria-label="分类" />
        </div>
      </Modal>

      <Modal
        open={confirmBatch}
        onClose={() => setConfirmBatch(false)}
        title={`确认采纳 ${pairs.length} 条建议`}
        footer={
          <>
            <Button variant="secondary" size="md" onClick={() => setConfirmBatch(false)}>
              取消
            </Button>
            <Button variant="primary" size="md" disabled={busy} onClick={() => void acceptAll()}>
              {busy ? '处理中…' : `确认采纳 ${pairs.length} 笔`}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-[var(--text-secondary)]">采纳后可逐笔修改。以下为前几条：</p>
          <div className="flex flex-col gap-1">
            {pairs.slice(0, 5).map(({ row, suggestion }) => (
              <div key={`${row.groupId}-${row.splitIndex}`} className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">{row.tx.description}</span>
                <span className="shrink-0 text-[var(--text-secondary)]">→ {suggestion.category_name}</span>
              </div>
            ))}
            {pairs.length > 5 && (
              <div className="text-[11px] text-[var(--text-secondary)]">其余 {pairs.length - 5} 笔未列出</div>
            )}
          </div>
        </div>
      </Modal>
    </div>
  )
}
