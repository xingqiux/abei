import { useMemo, useState, type ReactNode } from 'react'
import { useExpenseByAsset, useExpenseByBudget, useExpenseByCategory, useExpenseByTag, useExpenseWithoutBudget, useExpenseWithoutCategory, useFinancialReport, useIncomeByRevenue, useSummaryBasic } from '../../api/queries'
import { KpiCard } from '../../components/granary/KpiCard'
import { CategoryBarChart } from '../../components/granary/CategoryBarChart'
import { Skeleton } from '../../components/granary/Skeleton'
import { EmptyState } from '../../components/granary/EmptyState'
import { addMonths, formatAmount, formatMonthDay, monthRange } from '../../lib/format'
import { topNWithOther } from '../../lib/insight'
import { useStaggerIn } from '../../motion/useStaggerIn'
import { useLenis } from '../../motion/useLenis'
import { MonthSwitcher } from './MonthSwitcher'
import { cashflowAmounts, summaryAmounts } from '../../lib/summary'
import { ErrorState } from '../../components/granary/ErrorState'

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

function RankingCard({ title, isLoading, isError, retry, data }: { title: string; isLoading: boolean; isError: boolean; retry: () => void; data: ReturnType<typeof topNWithOther> }) {
  return (
    <Card title={title}>
      {isLoading ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-4" />
          ))}
        </div>
      ) : isError ? (
        <ErrorState message={`${title}加载失败`} onRetry={retry} />
      ) : data.length === 0 ? (
        <div className="py-6 text-center text-[12.5px]" style={{ color: 'var(--g-ink-2)' }}>
          该月无数据
        </div>
      ) : (
        <CategoryBarChart data={data} />
      )}
    </Card>
  )
}

export function ReportsPage() {
  const [month, setMonth] = useState(() => {
    const d = new Date()
    d.setDate(1)
    return d
  })
  const range = useMemo(() => monthRange(month), [month])

  const summaryQuery = useSummaryBasic(range)

  const categoryQuery = useExpenseByCategory(range)
  const revenueQuery = useIncomeByRevenue(range)
  const assetOutflowQuery = useExpenseByAsset(range)
  const tagQuery = useExpenseByTag(range)
  const budgetQuery = useExpenseByBudget(range)
  const uncategorizedQuery = useExpenseWithoutCategory(range)
  const unbudgetedQuery = useExpenseWithoutBudget(range)
  const financialReportQuery = useFinancialReport(range)

  const kpis = useMemo(() => {
    const s = summaryQuery.data
    if (!s) return null
    return {
      spent: summaryAmounts(s, 'spent'),
      earned: summaryAmounts(s, 'earned'),
      net: cashflowAmounts(s),
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
  const topTxRef = useStaggerIn<HTMLDivElement>([financialReportQuery.isSuccess, range.start])
  const lenisRef = useLenis<HTMLDivElement>()

  return (
    <div ref={lenisRef} className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-[18px]" style={{ fontWeight: 'var(--g-weight-demibold)', color: 'var(--g-ink)' }}>
          报表
        </h1>
        <MonthSwitcher
          month={month}
          onPrev={() => setMonth((m) => addMonths(m, -1))}
          onNext={() => setMonth((m) => addMonths(m, 1))}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {summaryQuery.isError ? (
          <div className="sm:col-span-3 rounded-[10px]" style={{ background: 'var(--g-surface)' }}>
            <ErrorState message="月度汇总加载失败" onRetry={() => void summaryQuery.refetch()} />
          </div>
        ) : summaryQuery.isLoading || !kpis ? (
          Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-[86px]" />)
        ) : (
          <>
            <KpiCard label="本月收入" amounts={kpis.earned} colorVar="var(--g-income)" sublabel={`${range.start} ~ ${range.end}`} signed />
            <KpiCard label="本月支出" amounts={kpis.spent} colorVar="var(--g-expense)" sublabel={`${range.start} ~ ${range.end}`} signed />
            <KpiCard
              label="本月净额"
              amounts={kpis.net}
              colorVar="var(--g-ink)"
              sublabel={`${range.start} ~ ${range.end}`}
              signed
            />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <RankingCard title="分类支出排行" isLoading={categoryQuery.isLoading} isError={categoryQuery.isError} retry={() => void categoryQuery.refetch()} data={categoryData} />
        <RankingCard title="收入来源排行" isLoading={revenueQuery.isLoading} isError={revenueQuery.isError} retry={() => void revenueQuery.refetch()} data={revenueData} />
        <RankingCard title="账户流出排行" isLoading={assetOutflowQuery.isLoading} isError={assetOutflowQuery.isError} retry={() => void assetOutflowQuery.refetch()} data={assetOutflowData} />
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <RankingCard title="标签支出排行" isLoading={tagQuery.isLoading} isError={tagQuery.isError} retry={() => void tagQuery.refetch()} data={tagData} />
        <RankingCard title="预算支出排行" isLoading={budgetQuery.isLoading} isError={budgetQuery.isError} retry={() => void budgetQuery.refetch()} data={budgetData} />
        <RankingCard title="转账流向" isLoading={financialReportQuery.isLoading} isError={financialReportQuery.isError} retry={() => void financialReportQuery.refetch()} data={transferData} />
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <RankingCard title="未分类支出" isLoading={uncategorizedQuery.isLoading} isError={uncategorizedQuery.isError} retry={() => void uncategorizedQuery.refetch()} data={uncategorizedData} />
        <RankingCard title="未编入预算支出" isLoading={unbudgetedQuery.isLoading} isError={unbudgetedQuery.isError} retry={() => void unbudgetedQuery.refetch()} data={unbudgetedData} />
      </div>

      <Card title="当月最大支出 Top 10">
        {financialReportQuery.isLoading ? (
          <div className="flex flex-col gap-1">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-8" />
            ))}
          </div>
        ) : financialReportQuery.isError ? (
          <ErrorState message="最大支出加载失败" onRetry={() => void financialReportQuery.refetch()} />
        ) : topTx.length === 0 ? (
          <EmptyState message="该月没有支出交易" />
        ) : (
          <div ref={topTxRef} className="flex flex-col">
            {topTx.map((row) => (
              <div key={`${row.group_id}:${row.currency_id}`} className="grid min-h-9 grid-cols-[48px_minmax(0,1fr)_auto] items-center gap-2 border-b border-[var(--g-border)] py-1.5 last:border-b-0">
                <span className="font-num text-[12px]" style={{ color: 'var(--g-ink-2)' }}>{formatMonthDay(row.date)}</span>
                <div className="min-w-0">
                  <div className="truncate text-[12.5px]" style={{ color: 'var(--g-ink)' }}>{row.title}</div>
                  {row.split_count > 1 && <div className="text-[10.5px]" style={{ color: 'var(--g-ink-2)' }}>{row.split_count} 条拆分</div>}
                </div>
                <span className="font-num shrink-0 text-right text-[12.5px]" style={{ color: 'var(--g-expense)' }}>
                  -{row.currency_symbol || row.currency_code}{formatAmount(row.amount)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
