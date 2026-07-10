import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import {
  useAccount,
  useAccountOverviewChart,
  useAccountTransactions,
  useDeleteTransaction,
} from '../../api/queries'
import { useDateRangeStore } from '../../store/dateRangeStore'
import { BalanceAreaChart } from '../../components/granary/BalanceAreaChart'
import { TransactionRow } from '../../components/granary/TransactionRow'
import { DeleteTransactionDialog } from '../../components/granary/DeleteTransactionDialog'
import { Skeleton } from '../../components/granary/Skeleton'
import { EmptyState } from '../../components/granary/EmptyState'
import emptyWalletUrl from '../../assets/lottie/empty-wallet.json?url'
import { formatAmount, formatMonthDay } from '../../lib/format'
import { toBalanceSeries } from '../../lib/chartSeries'
import { useStaggerIn } from '../../motion/useStaggerIn'
import { useRecordTxStore } from '../../store/recordTxStore'
import { showToast } from '../../store/toastStore'
import { FireflyApiError } from '../../api/client'
import type { TransactionSplit } from '../../api/schemas'
import { buildEditPayload, isEditableTransactionType } from '../record-transaction/editPayload'

const PAGE_SIZE = 50

const TYPE_LABEL: Record<string, string> = {
  asset: '资产',
  expense: '支出',
  revenue: '收入',
  liability: '负债',
  liabilities: '负债',
  loan: '贷款',
  debt: '债务',
  mortgage: '抵押',
  cash: '现金',
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-[10px] p-3.5" style={{ background: 'var(--g-surface)', boxShadow: 'var(--g-shadow)' }}>
      <div
        className="mb-3 text-[12px]"
        style={{ color: 'var(--g-ink-2)', fontWeight: 'var(--g-weight-demibold)', letterSpacing: '.02em' }}
      >
        {title}
      </div>
      {children}
    </div>
  )
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-[12.5px]">
      <span style={{ color: 'var(--g-ink-2)' }}>{label}</span>
      <span className="min-w-0 text-right" style={{ color: 'var(--g-ink)' }}>
        {children}
      </span>
    </div>
  )
}

interface LoadedRow {
  groupId: string
  splitCount: number
  tx: TransactionSplit
}

export function AccountDetailPage() {
  const params = useParams({ strict: false })
  const accountId = String(params.accountId ?? '')
  const range = useDateRangeStore()
  const rangeLabel = `${formatMonthDay(range.start)} → ${formatMonthDay(range.end)}`

  const accountQuery = useAccount(accountId)
  const chartQuery = useAccountOverviewChart(range, {
    accounts: [accountId],
    enabled: !!accountId,
  })
  const [page, setPage] = useState(1)
  const [loaded, setLoaded] = useState<LoadedRow[]>([])
  const [pendingDelete, setPendingDelete] = useState<LoadedRow | null>(null)

  const txQuery = useAccountTransactions(accountId, range, { limit: PAGE_SIZE, page })
  const openEdit = useRecordTxStore((s) => s.openEdit)
  const deleteMutation = useDeleteTransaction()

  useEffect(() => {
    setPage(1)
    setLoaded([])
  }, [accountId, range.start, range.end])

  useEffect(() => {
    if (!txQuery.data) return
    const rows: LoadedRow[] = txQuery.data.data
      .map((g) => {
        const splits = g.attributes.transactions
        const tx = splits[0]
        if (!tx) return null
        return { groupId: g.id, splitCount: splits.length, tx }
      })
      .filter((r): r is LoadedRow => r !== null)
    setLoaded((prev) => (page === 1 ? rows : [...prev, ...rows]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txQuery.data])

  const totalPages = txQuery.data?.meta?.pagination?.total_pages ?? 1
  const totalTx = txQuery.data?.meta?.pagination?.total
  const canLoadMore = page < totalPages
  const listRef = useStaggerIn<HTMLDivElement>([txQuery.isSuccess && page === 1])

  const balanceSeries = useMemo(() => {
    const raw = chartQuery.data ?? []
    if (raw.length === 0) return []
    const series = toBalanceSeries(raw[0])
    return series.points.length > 0 ? [series] : []
  }, [chartQuery.data])

  const account = accountQuery.data?.data
  const attrs = account?.attributes
  const symbol = attrs?.currency_symbol ?? '¥'
  const balance = Number(attrs?.current_balance ?? 0)
  const typeLabel = attrs ? (TYPE_LABEL[attrs.type] ?? attrs.type) : ''
  const tail = attrs?.account_number
    ? attrs.account_number.slice(-4)
    : attrs?.iban
      ? attrs.iban.slice(-4)
      : null

  async function confirmDelete() {
    if (!pendingDelete) return
    try {
      await deleteMutation.mutateAsync(pendingDelete.groupId)
      showToast({ kind: 'success', message: '已删除交易' })
      setPendingDelete(null)
    } catch (err) {
      const message = err instanceof FireflyApiError ? err.message : '删除失败，请重试'
      showToast({ kind: 'error', message, duration: 6000 })
    }
  }

  if (accountQuery.isError) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <EmptyState icon="🏦" message="账户加载失败或不存在" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <BackLink />
          {accountQuery.isLoading || !attrs ? (
            <Skeleton className="h-7 w-40" />
          ) : (
            <>
              <h1
                className="truncate text-[18px]"
                style={{ fontWeight: 'var(--g-weight-demibold)', color: 'var(--g-ink)' }}
              >
                {attrs.name}
              </h1>
              <div className="flex flex-wrap items-center gap-2 text-[12px]" style={{ color: 'var(--g-ink-2)' }}>
                <span>{typeLabel}</span>
                {attrs.active === false && <span style={{ color: 'var(--g-warn)' }}>已停用</span>}
                {tail && (
                  <span className="font-num">
                    •••• {tail}
                  </span>
                )}
                <span>· {rangeLabel}</span>
              </div>
            </>
          )}
        </div>
        {attrs && (
          <div className="text-right">
            <div className="text-[11px]" style={{ color: 'var(--g-ink-2)', letterSpacing: '.04em', textTransform: 'uppercase' }}>
              当前余额
            </div>
            <div
              className="font-num mt-0.5"
              style={{
                fontSize: 20,
                fontWeight: 600,
                color: balance < 0 ? 'var(--g-expense)' : 'var(--g-ink)',
              }}
            >
              {symbol}
              {formatAmount(balance)}
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 min-[900px]:grid-cols-[0.9fr_1.1fr]">
        <Card title="基本信息">
          {accountQuery.isLoading || !attrs ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-5" />
              ))}
            </div>
          ) : (
            <div className="flex flex-col">
              <InfoRow label="类型">{typeLabel}</InfoRow>
              <InfoRow label="币种">
                <span className="font-num">
                  {attrs.currency_code ?? '—'} {symbol}
                </span>
              </InfoRow>
              {attrs.opening_balance != null && attrs.opening_balance !== '' && (
                <InfoRow label="初始余额">
                  <span className="font-num">
                    {symbol}
                    {formatAmount(attrs.opening_balance)}
                    {attrs.opening_balance_date && (
                      <span style={{ color: 'var(--g-ink-2)' }}>
                        {' '}
                        · {attrs.opening_balance_date.slice(0, 10)}
                      </span>
                    )}
                  </span>
                </InfoRow>
              )}
              <InfoRow label="最近活动">
                <span className="font-num">
                  {attrs.last_activity ? attrs.last_activity.slice(0, 10) : '—'}
                </span>
              </InfoRow>
              {attrs.account_role && (
                <InfoRow label="角色">
                  <span className="font-num text-[11.5px]">{attrs.account_role}</span>
                </InfoRow>
              )}
              {attrs.notes && (
                <InfoRow label="备注">
                  <span className="text-[12px] leading-relaxed">{attrs.notes}</span>
                </InfoRow>
              )}
            </div>
          )}
        </Card>

        <Card title="余额趋势">
          {chartQuery.isLoading ? (
            <Skeleton className="h-[200px]" />
          ) : chartQuery.isError ? (
            <EmptyState icon="📉" message="余额趋势加载失败" />
          ) : balanceSeries.length === 0 ? (
            <EmptyState icon="📉" message="本期暂无余额序列" />
          ) : (
            <BalanceAreaChart series={balanceSeries} height={180} />
          )}
        </Card>
      </div>

      <Card title={typeof totalTx === 'number' ? `流水 · 共 ${totalTx} 笔` : '流水'}>
        {txQuery.isLoading && page === 1 ? (
          <div className="flex flex-col gap-1">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-8" />
            ))}
          </div>
        ) : loaded.length === 0 ? (
          <EmptyState lottieSrc={emptyWalletUrl} message="本期该账户暂无交易" />
        ) : (
          <>
            <div ref={listRef} className="flex flex-col">
              {loaded.map((row) => {
                const editable = isEditableTransactionType(row.tx.type)
                return (
                  <TransactionRow
                    key={row.groupId}
                    tx={row.tx}
                    ids={
                      editable
                        ? {
                            groupId: row.groupId,
                            journalId: String(row.tx.transaction_journal_id ?? row.groupId),
                          }
                        : undefined
                    }
                    onEdit={
                      editable
                        ? () => openEdit(buildEditPayload(row.groupId, row.tx, row.splitCount))
                        : undefined
                    }
                    onDelete={editable ? () => setPendingDelete(row) : undefined}
                  />
                )
              })}
            </div>
            {canLoadMore && (
              <div className="flex justify-center pt-3">
                <button
                  type="button"
                  disabled={txQuery.isFetching}
                  onClick={() => setPage((p) => p + 1)}
                  className="rounded-[6px] px-3 py-1.5 text-[12.5px] disabled:opacity-60"
                  style={{ background: 'var(--g-surface-2)', color: 'var(--g-ink)' }}
                >
                  {txQuery.isFetching ? '加载中…' : '加载更多'}
                </button>
              </div>
            )}
          </>
        )}
      </Card>

      <DeleteTransactionDialog
        open={!!pendingDelete}
        tx={pendingDelete?.tx ?? null}
        pending={deleteMutation.isPending}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
    </div>
  )
}

function BackLink() {
  return (
    <Link
      to="/accounts"
      className="inline-flex w-fit items-center gap-1 text-[12.5px]"
      style={{ color: 'var(--g-accent)' }}
    >
      <ArrowLeft aria-hidden size={13} color="currentColor" />
      返回账户
    </Link>
  )
}
