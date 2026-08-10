import { useMemo, useState, type ReactNode } from 'react'
import { useAccountOverviewChart, useExpenseByAsset, useExpenseByBudget, useExpenseByCategory, useExpenseByTag, useExpenseWithoutBudget, useExpenseWithoutCategory, useFinancialReport, useIncomeByRevenue, useSummaryBasic } from '../../api/queries'
import { KpiCard } from '../../components/abei/KpiCard'
import { CategoryBarChart } from '../../components/abei/CategoryBarChart'
import { BalanceAreaChart } from '../../components/abei/BalanceAreaChart'
import { Skeleton } from '../../components/abei/Skeleton'
import { EmptyState } from '../../components/abei/EmptyState'
import { addMonths, formatAmount, formatMonthDay, monthRange } from '../../lib/format'
import { topNWithOther } from '../../lib/insight'
import { pickTopBalanceSeries } from '../../lib/chartSeries'
import { useStaggerIn } from '../../motion/useStaggerIn'
import { MonthSwitcher } from './MonthSwitcher'
import { cashflowAmounts, summaryAmounts } from '../../lib/summary'
import { ErrorState } from '../../components/abei/ErrorState'
import { Card } from '../../components/ui/Card'
import { useTodoCounts } from '../../hooks/useTodoCounts'
import { useRecordTxStore } from '../../store/recordTxStore'

/**
 * 带小标题的图表块。这里原本自己写了个叫 `Card` 的组件，把共享的那个遮住了，
 * 于是这页的卡片底色/抬升跟别处对不上。现在只在共享 Card 上加一行标题。
 */
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <h2 className="mb-3 text-xs font-semibold tracking-wide text-[var(--text-secondary)]">{title}</h2>
      {children}
    </Card>
  )
}

/**
 * 排行卡。没数据的时候整块不渲染（设计稿 06 §3）——
 * 十来个「该月无数据」的空盒子把真正有数的那两三块淹了，
 * 页面级空态在下面统一给一条。
 */
function RankingCard({ title, isLoading, isError, error, retry, data }: { title: string; isLoading: boolean; isError: boolean; error?: unknown; retry: () => void; data: ReturnType<typeof topNWithOther> }) {
  if (!isLoading && !isError && data.length === 0) return null
  return (
    <Panel title={title}>
      {isLoading ? (
        <div className="flex flex-col gap-2" role="status" aria-label={`${title}加载中`}>
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-4" />
          ))}
        </div>
      ) : isError ? (
        <ErrorState message={`${title}加载失败`} error={error} onRetry={retry} />
      ) : (
        <CategoryBarChart data={data} />
      )}
    </Panel>
  )
}

export function AnalysisPage() {
  const [month, setMonth] = useState(() => {
    const d = new Date()
    d.setDate(1)
    return d
  })
  const range = useMemo(() => monthRange(month), [month])
  const todo = useTodoCounts()
  const openRecordForm = useRecordTxStore((state) => state.openForm)

  const summaryQuery = useSummaryBasic(range)

  const categoryQuery = useExpenseByCategory(range)
  const revenueQuery = useIncomeByRevenue(range)
  const assetOutflowQuery = useExpenseByAsset(range)
  const tagQuery = useExpenseByTag(range)
  const budgetQuery = useExpenseByBudget(range)
  const uncategorizedQuery = useExpenseWithoutCategory(range)
  const unbudgetedQuery = useExpenseWithoutBudget(range)
  const financialReportQuery = useFinancialReport(range)
  const chartQuery = useAccountOverviewChart(range, { preselected: 'assets' })

  const kpis = useMemo(() => {
    const s = summaryQuery.data
    if (!s) return null
    return {
      spent: summaryAmounts(s, 'spent'),
      earned: summaryAmounts(s, 'earned'),
      net: cashflowAmounts(s),
      netWorth: summaryAmounts(s, 'net-worth'),
    }
  }, [summaryQuery.data])

  const categoryData = useMemo(() => topNWithOther(categoryQuery.data ?? []), [categoryQuery.data])
  const revenueData = useMemo(() => topNWithOther(revenueQuery.data ?? []), [revenueQuery.data])
  const assetOutflowData = useMemo(() => topNWithOther(assetOutflowQuery.data ?? []), [assetOutflowQuery.data])
  const tagData = useMemo(() => topNWithOther(tagQuery.data ?? []), [tagQuery.data])
  const budgetData = useMemo(() => topNWithOther(budgetQuery.data ?? []), [budgetQuery.data])
  const uncategorizedData = useMemo(() => topNWithOther(uncategorizedQuery.data ?? []), [uncategorizedQuery.data])
  const unbudgetedData = useMemo(() => topNWithOther(unbudgetedQuery.data ?? []), [unbudgetedQuery.data])
  const transferData = useMemo(() => topNWithOther(
    (financialReportQuery.data?.data.transfer_flows ?? []).map((flow) => ({
      id: `${flow.source_account_id}:${flow.destination_account_id}:${flow.currency_id}`,
      name: `${flow.source_account_name} → ${flow.destination_account_name}`,
      difference: flow.amount,
      currency_code: flow.currency_code,
    })),
  ), [financialReportQuery.data])
  const topTx = financialReportQuery.data?.data.top_expenses ?? []
  const topTxRef = useStaggerIn<HTMLUListElement>([financialReportQuery.isSuccess, range.start])
  const balanceSeries = useMemo(
    () => pickTopBalanceSeries(chartQuery.data ?? [], 4),
    [chartQuery.data],
  )

  const anyLoading = categoryQuery.isLoading || revenueQuery.isLoading || financialReportQuery.isLoading
  const rankingData = [
    categoryData, revenueData, assetOutflowData, tagData, budgetData,
    transferData, uncategorizedData, unbudgetedData,
  ]
  /** 整月一条已入账交易都没有：给一条能点的空态，而不是十来个空盒子 */
  const monthEmpty = !anyLoading
    && rankingData.every((data) => data.length === 0)
    && topTx.length === 0
    && balanceSeries.length === 0

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-[var(--text-primary)]">分析</h1>
        <MonthSwitcher
          month={month}
          onPrev={() => setMonth((m) => addMonths(m, -1))}
          onNext={() => setMonth((m) => addMonths(m, 1))}
        />
      </div>

      {/* 四张 KPI：原先是 sm:grid-cols-3 却渲染 4 张，第 4 张永远单独掉到第二行 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {summaryQuery.isError ? (
          <div className="sm:col-span-2 lg:col-span-4">
            <Card padded={false}>
              <ErrorState message="月度汇总加载失败" error={summaryQuery.error} onRetry={() => void summaryQuery.refetch()} />
            </Card>
          </div>
        ) : summaryQuery.isLoading || !kpis ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[86px]" />)
        ) : (
          <>
            <KpiCard label="本月收入" amounts={kpis.earned} semantic="income" sublabel={`${range.start} ~ ${range.end}`} signed />
            <KpiCard label="本月支出" amounts={kpis.spent} semantic="expense" sublabel={`${range.start} ~ ${range.end}`} signed />
            {/* 净资产是个时点数，配区间副标题看着像「这段时间的净资产」 */}
            <KpiCard label="总净资产" amounts={kpis.netWorth} semantic="neutral" sublabel={`截至 ${range.end}`} signed />
            <KpiCard label="本月净额" amounts={kpis.net} semantic="neutral" sublabel={`${range.start} ~ ${range.end}`} signed />
          </>
        )}
      </div>

      {monthEmpty ? (
        <Card>
          <EmptyState
            statusIcon="inbox"
            message={
              todo.total > 0
                ? `本月还没有已入账交易，收件箱有 ${todo.total} 笔待处理`
                : '本月还没有已入账交易'
            }
            action={
              todo.total > 0
                ? { label: '去处理收件箱', to: '/bill-inbox' }
                : { label: '记一笔', onClick: openRecordForm }
            }
          />
        </Card>
      ) : (
        <>
          {(chartQuery.isLoading || chartQuery.isError || balanceSeries.length > 0) && (
            <Panel title="账户余额">
              {chartQuery.isLoading ? (
                <Skeleton className="h-[220px]" />
              ) : chartQuery.isError ? (
                <ErrorState message="余额趋势加载失败" error={chartQuery.error} onRetry={() => void chartQuery.refetch()} />
              ) : (
                <BalanceAreaChart series={balanceSeries} />
              )}
            </Panel>
          )}

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            <RankingCard title="分类支出排行" isLoading={categoryQuery.isLoading} isError={categoryQuery.isError} error={categoryQuery.error} retry={() => void categoryQuery.refetch()} data={categoryData} />
            <RankingCard title="收入来源排行" isLoading={revenueQuery.isLoading} isError={revenueQuery.isError} error={revenueQuery.error} retry={() => void revenueQuery.refetch()} data={revenueData} />
            <RankingCard title="账户流出排行" isLoading={assetOutflowQuery.isLoading} isError={assetOutflowQuery.isError} error={assetOutflowQuery.error} retry={() => void assetOutflowQuery.refetch()} data={assetOutflowData} />
          </div>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            <RankingCard title="标签支出排行" isLoading={tagQuery.isLoading} isError={tagQuery.isError} error={tagQuery.error} retry={() => void tagQuery.refetch()} data={tagData} />
            <RankingCard title="预算支出排行" isLoading={budgetQuery.isLoading} isError={budgetQuery.isError} error={budgetQuery.error} retry={() => void budgetQuery.refetch()} data={budgetData} />
            <RankingCard title="转账流向" isLoading={financialReportQuery.isLoading} isError={financialReportQuery.isError} error={financialReportQuery.error} retry={() => void financialReportQuery.refetch()} data={transferData} />
          </div>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <RankingCard title="未分类支出" isLoading={uncategorizedQuery.isLoading} isError={uncategorizedQuery.isError} error={uncategorizedQuery.error} retry={() => void uncategorizedQuery.refetch()} data={uncategorizedData} />
            <RankingCard title="未编入预算支出" isLoading={unbudgetedQuery.isLoading} isError={unbudgetedQuery.isError} error={unbudgetedQuery.error} retry={() => void unbudgetedQuery.refetch()} data={unbudgetedData} />
          </div>

          {(financialReportQuery.isLoading || financialReportQuery.isError || topTx.length > 0) && (
            <Panel title="当月最大支出 Top 10">
              {financialReportQuery.isLoading ? (
                <div className="flex flex-col gap-1" role="status" aria-label="最大支出加载中">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <Skeleton key={i} className="h-8" />
                  ))}
                </div>
              ) : financialReportQuery.isError ? (
                <ErrorState message="最大支出加载失败" error={financialReportQuery.error} onRetry={() => void financialReportQuery.refetch()} />
              ) : (
                <ul ref={topTxRef} role="list" className="divide-y divide-[var(--border-subtle)]">
                  {topTx.map((row) => (
                    <li key={`${row.group_id}:${row.currency_id}`} className="grid min-h-9 grid-cols-[48px_minmax(0,1fr)_auto] items-center gap-2 py-1.5">
                      <span className="num text-xs text-[var(--text-secondary)]">{formatMonthDay(row.date)}</span>
                      <div className="min-w-0">
                        <div className="truncate text-[12.5px] text-[var(--text-primary)]">{row.title}</div>
                        {row.split_count > 1 && <div className="text-[10.5px] text-[var(--text-secondary)]">{row.split_count} 条拆分</div>}
                      </div>
                      <span className="num shrink-0 text-right text-[12.5px] text-[var(--text-primary)]">
                        -{row.currency_symbol || row.currency_code}{formatAmount(row.amount)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          )}
        </>
      )}
    </div>
  )
}
