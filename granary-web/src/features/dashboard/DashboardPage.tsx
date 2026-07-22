import { useMemo, useState, type ReactNode } from 'react'
import { useDateRangeStore } from '../../store/dateRangeStore'
import {
  useAccountOverviewChart,
  useDeleteTransaction,
  useExpenseByCategory,
  useSummaryBasic,
  useTransactions,
} from '../../api/queries'
import { KpiCard } from '../../components/granary/KpiCard'
import { CategoryBarChart, type CategoryBarDatum } from '../../components/granary/CategoryBarChart'
import { BalanceAreaChart } from '../../components/granary/BalanceAreaChart'
import { TransactionRow } from '../../components/granary/TransactionRow'
import { DeleteTransactionDialog } from '../../components/granary/DeleteTransactionDialog'
import { Skeleton } from '../../components/granary/Skeleton'
import { EmptyState } from '../../components/granary/EmptyState'
import { formatMonthDay } from '../../lib/format'
import { pickTopBalanceSeries } from '../../lib/chartSeries'
import { useStaggerIn } from '../../motion/useStaggerIn'
import { showToast } from '../../store/toastStore'
import { FireflyApiError } from '../../api/client'
import { isEditableTransactionType } from '../record-transaction/editPayload'
import { flattenTransactionGroups, type TransactionSplitRow } from '../../lib/transactionGroup'
import { cashflowAmounts, summaryAmounts } from '../../lib/summary'
import { ErrorState } from '../../components/granary/ErrorState'
import { topNWithOther } from '../../lib/insight'

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

type RecentRow = TransactionSplitRow

export function DashboardPage() {
  const range = useDateRangeStore()
  const rangeLabel = `${formatMonthDay(range.start)} → ${formatMonthDay(range.end)}`

  const summaryQuery = useSummaryBasic(range)
  const categoryQuery = useExpenseByCategory(range)
  const recentQuery = useTransactions(range, { limit: 12, page: 1, type: 'all' })
  // 资产账户余额面积线（最多 4 条）；preselected=assets，避免 frontpageAccounts 失效返回 []
  const chartQuery = useAccountOverviewChart(range, { preselected: 'assets' })
  const deleteMutation = useDeleteTransaction()
  const [pendingDelete, setPendingDelete] = useState<RecentRow | null>(null)

  const kpis = useMemo(() => {
    const s = summaryQuery.data
    if (!s) return null
    return {
      spent: summaryAmounts(s, 'spent'),
      earned: summaryAmounts(s, 'earned'),
      netWorth: summaryAmounts(s, 'net-worth'),
      netCashflow: cashflowAmounts(s),
    }
  }, [summaryQuery.data])

  const categoryData = useMemo<CategoryBarDatum[]>(() => {
    return topNWithOther(categoryQuery.data ?? [], 6)
  }, [categoryQuery.data])

  const balanceSeries = useMemo(
    () => pickTopBalanceSeries(chartQuery.data ?? [], 4),
    [chartQuery.data],
  )

  const recentRows: RecentRow[] = flattenTransactionGroups(recentQuery.data?.data ?? [])
  const pendingDeleteSplits = pendingDelete
    ? recentRows.filter((row) => row.groupId === pendingDelete.groupId).map((row) => row.tx)
    : []
  const recentListRef = useStaggerIn<HTMLDivElement>([recentQuery.isSuccess])

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

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {summaryQuery.isError ? (
          <div className="col-span-full rounded-[10px]" style={{ background: 'var(--g-surface)' }}>
            <ErrorState message="财务汇总加载失败" onRetry={() => void summaryQuery.refetch()} />
          </div>
        ) : summaryQuery.isLoading || !kpis ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[86px]" />)
        ) : (
          <>
            <KpiCard
              label="本期支出"
              amounts={kpis.spent}
              colorVar="var(--g-expense)"
              sublabel={rangeLabel}
              signed
            />
            <KpiCard
              label="本期收入"
              amounts={kpis.earned}
              colorVar="var(--g-income)"
              sublabel={rangeLabel}
              signed
            />
            <KpiCard
              label="净现金流"
              amounts={kpis.netCashflow}
              colorVar="var(--g-ink)"
              sublabel={rangeLabel}
              signed
            />
            <KpiCard
              label="总净资产"
              amounts={kpis.netWorth}
              colorVar="var(--g-ink)"
              sublabel={rangeLabel}
              signed
            />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 min-[900px]:grid-cols-[1.08fr_0.92fr]">
        <Card title="分类支出 TOP">
          {categoryQuery.isLoading ? (
            <div className="flex flex-col gap-2.5">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-4" />
              ))}
            </div>
          ) : categoryQuery.isError ? (
            <ErrorState message="分类支出加载失败" onRetry={() => void categoryQuery.refetch()} />
          ) : categoryData.length === 0 ? (
            <EmptyState icon="📊" message="本期暂无支出分类数据" />
          ) : (
            <CategoryBarChart data={categoryData} />
          )}
        </Card>

        <Card title="近期交易">
          {recentQuery.isLoading ? (
            <div className="flex flex-col gap-1">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-8" />
              ))}
            </div>
          ) : recentQuery.isError ? (
            <ErrorState message="近期交易加载失败" onRetry={() => void recentQuery.refetch()} />
          ) : recentRows.length === 0 ? (
            <EmptyState icon="🧾" message="本期暂无交易" />
          ) : (
            <div ref={recentListRef} className="flex flex-col">
              {recentRows.map((row) => {
                // Opening balance / Reconciliation 等不可行操作（避免误改初始余额）
                const deletable = row.splitIndex === 0 && isEditableTransactionType(row.tx.type)
                return (
                  <TransactionRow
                    key={`${row.groupId}-${row.tx.transaction_journal_id ?? row.splitIndex}`}
                    tx={row.tx}
                    ids={
                      deletable
                        ? {
                            groupId: row.groupId,
                            journalId: String(row.tx.transaction_journal_id ?? row.groupId),
                          }
                        : undefined
                    }
                    onDelete={deletable ? () => setPendingDelete(row) : undefined}
                  />
                )
              })}
            </div>
          )}
        </Card>
      </div>

      <Card title="账户余额">
        {chartQuery.isLoading ? (
          <Skeleton className="h-[220px]" />
        ) : chartQuery.isError ? (
          <ErrorState message="余额趋势加载失败" onRetry={() => void chartQuery.refetch()} />
        ) : balanceSeries.length === 0 ? (
          <EmptyState icon="📉" message="本期暂无账户余额序列" />
        ) : (
          <BalanceAreaChart series={balanceSeries} />
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
