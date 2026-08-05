import { useMemo, useState, type ReactNode } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import { ArrowLeftIcon, BanknotesIcon } from '@heroicons/react/24/outline'
import {
  useAccount,
  useAccountOverviewChart,
  useDeleteTransaction,
  useInfiniteAccountTransactions,
} from '../../api/queries'
import { useDateRangeStore } from '../../store/dateRangeStore'
import { BalanceAreaChart } from '../../components/granary/BalanceAreaChart'
import { TransactionRow } from '../../components/granary/TransactionRow'
import { DeleteTransactionDialog } from '../../components/granary/DeleteTransactionDialog'
import { Skeleton } from '../../components/granary/Skeleton'
import { EmptyState } from '../../components/granary/EmptyState'
import { formatAmount, formatMonthDay } from '../../lib/format'
import { toBalanceSeries } from '../../lib/chartSeries'
import { useStaggerIn } from '../../motion/useStaggerIn'
import { showToast } from '../../store/toastStore'
import { FireflyApiError } from '../../api/client'
import { isEditableTransactionType } from '../record-transaction/editPayload'
import { flattenTransactionGroups, type TransactionSplitRow } from '../../lib/transactionGroup'
import { compareDecimalStrings } from '../../lib/decimal'
import { ErrorState } from '../../components/granary/ErrorState'

/** 账户流水每页条数；偏小以便「加载更多」在常见数据量下可用，并便于分页失效回归。 */
const PAGE_SIZE = 20

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
      <span className="min-w-0 text-right text-gray-900 dark:text-gray-100">
        {children}
      </span>
    </div>
  )
}

type LoadedRow = TransactionSplitRow

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
  const [pendingDelete, setPendingDelete] = useState<LoadedRow | null>(null)

  const txQuery = useInfiniteAccountTransactions(accountId, range, { limit: PAGE_SIZE })
  const deleteMutation = useDeleteTransaction()

  const rows: LoadedRow[] = useMemo(() => {
    const pages = txQuery.data?.pages ?? []
    return flattenTransactionGroups(pages.flatMap((page) => page.data))
  }, [txQuery.data])

  const totalTx = txQuery.data?.pages[0]?.meta?.pagination?.total
  const canLoadMore = !!txQuery.hasNextPage
  const pendingDeleteSplits = pendingDelete
    ? rows.filter((row) => row.groupId === pendingDelete.groupId).map((row) => row.tx)
    : []
  const listRef = useStaggerIn<HTMLDivElement>([txQuery.isSuccess && (txQuery.data?.pages.length ?? 0) === 1])

  const balanceSeries = useMemo(() => {
    const raw = chartQuery.data ?? []
    if (raw.length === 0) return []
    const series = toBalanceSeries(raw[0])
    return series.points.length > 0 ? [series] : []
  }, [chartQuery.data])

  const account = accountQuery.data?.data
  const attrs = account?.attributes
  const symbol = attrs?.currency_symbol ?? attrs?.currency_code ?? ''
  const balance = attrs?.current_balance ?? '0'
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
      showToast({ kind: 'success', message: '交易已移入回收站' })
      setPendingDelete(null)
    } catch (err) {
      const message = err instanceof FireflyApiError ? err.message : '移入回收站失败，请重试'
      showToast({ kind: 'error', message, duration: 6000 })
    }
  }

  if (accountQuery.isError) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <ErrorState message="账户加载失败或不存在" onRetry={() => void accountQuery.refetch()} />
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
              <div className="flex flex-wrap items-center gap-2 text-[12px] text-gray-500 dark:text-gray-400">
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
                color: compareDecimalStrings(balance, '0') < 0 ? 'var(--g-expense)' : 'var(--g-ink)',
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
        {txQuery.isLoading ? (
          <div className="flex flex-col gap-1">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-8" />
            ))}
          </div>
          ) : txQuery.isError ? (
            <ErrorState message="账户流水加载失败" onRetry={() => void txQuery.refetch()} />
          ) : rows.length === 0 ? (
          <EmptyState icon={<BanknotesIcon aria-hidden className="size-9 text-gray-400" />} message="本期该账户暂无交易" />
        ) : (
          <>
            <div ref={listRef} className="flex flex-col">
              {rows.map((row) => {
                const deletable = row.splitIndex === 0 && isEditableTransactionType(row.tx.type)
                return (
                  <TransactionRow
                    key={`${row.groupId}-${row.tx.transaction_journal_id ?? row.splitIndex}`}
                    tx={row.tx}
                    ids={{ groupId: row.groupId, journalId: String(row.tx.transaction_journal_id ?? row.groupId) }}
                    onDelete={deletable ? () => setPendingDelete(row) : undefined}
                  />
                )
              })}
            </div>
            {canLoadMore && (
              <div className="flex justify-center pt-3">
                <button
                  type="button"
                  disabled={txQuery.isFetchingNextPage}
                  onClick={() => void txQuery.fetchNextPage()}
                  className="rounded-[6px] px-3 py-1.5 text-[12.5px] disabled:opacity-60"
                  style={{ background: 'var(--g-surface-2)', color: 'var(--g-ink)' }}
                >
                  {txQuery.isFetchingNextPage ? '加载中…' : '加载更多'}
                </button>
              </div>
            )}
          </>
        )}
      </Card>

      <DeleteTransactionDialog
        open={!!pendingDelete}
        splits={pendingDeleteSplits}
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
      <ArrowLeftIcon aria-hidden className="size-3.5" />
      返回账户
    </Link>
  )
}
