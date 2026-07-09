import { useMemo, type ReactNode } from 'react'
import { useDateRangeStore } from '../../store/dateRangeStore'
import { useExpenseByCategory, useSummaryBasic, useTransactions } from '../../api/queries'
import { KpiCard } from '../../components/granary/KpiCard'
import { TodoCard } from '../../components/granary/TodoCard'
import { CategoryBarChart, type CategoryBarDatum } from '../../components/granary/CategoryBarChart'
import { TransactionRow } from '../../components/granary/TransactionRow'
import { Skeleton } from '../../components/granary/Skeleton'
import { EmptyState } from '../../components/granary/EmptyState'
import { formatMonthDay } from '../../lib/format'
import { useStaggerIn } from '../../motion/useStaggerIn'

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

export function DashboardPage() {
  const range = useDateRangeStore()
  const rangeLabel = `${formatMonthDay(range.start)} → ${formatMonthDay(range.end)}`

  const summaryQuery = useSummaryBasic(range)
  const categoryQuery = useExpenseByCategory(range)
  const recentQuery = useTransactions(range, { limit: 12, page: 1, type: 'all' })

  const kpis = useMemo(() => {
    const s = summaryQuery.data
    if (!s) return null
    const spent = Number(s['spent-in-CNY']?.monetary_value ?? 0)
    const earned = Number(s['earned-in-CNY']?.monetary_value ?? 0)
    const netWorth = Number(s['net-worth-in-CNY']?.monetary_value ?? 0)
    const netCashflow = earned + spent
    return { spent, earned, netWorth, netCashflow }
  }, [summaryQuery.data])

  const categoryData = useMemo<CategoryBarDatum[]>(() => {
    const rows = categoryQuery.data ?? []
    const sorted = [...rows].sort((a, b) => Math.abs(b.difference_float) - Math.abs(a.difference_float))
    const top = sorted.slice(0, 6).map((r) => ({ name: r.name, value: Math.abs(r.difference_float) }))
    const restSum = sorted.slice(6).reduce((acc, r) => acc + Math.abs(r.difference_float), 0)
    if (restSum > 0) top.push({ name: '其他', value: restSum })
    return top
  }, [categoryQuery.data])

  const recentTx = recentQuery.data?.data.map((g) => g.attributes.transactions[0]).filter(Boolean) ?? []
  const recentListRef = useStaggerIn<HTMLDivElement>([recentQuery.isSuccess])

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {summaryQuery.isLoading || !kpis ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[86px]" />)
        ) : (
          <>
            <KpiCard
              label="本期支出"
              value={kpis.spent}
              colorVar="var(--g-expense)"
              sublabel={rangeLabel}
              staggerIndex={0}
              signed
            />
            <KpiCard
              label="本期收入"
              value={kpis.earned}
              colorVar="var(--g-income)"
              sublabel={rangeLabel}
              staggerIndex={1}
              signed
            />
            <KpiCard
              label="净现金流"
              value={kpis.netCashflow}
              colorVar={kpis.netCashflow >= 0 ? 'var(--g-income)' : 'var(--g-ink)'}
              sublabel={rangeLabel}
              staggerIndex={2}
              signed
            />
            <KpiCard
              label="总净资产"
              value={kpis.netWorth}
              colorVar="var(--g-ink)"
              sublabel={rangeLabel}
              staggerIndex={3}
              signed
            />
          </>
        )}
      </div>

      <TodoCard />

      <div className="grid grid-cols-1 gap-4 min-[900px]:grid-cols-[1.08fr_0.92fr]">
        <Card title="分类支出 TOP">
          {categoryQuery.isLoading ? (
            <div className="flex flex-col gap-2.5">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-4" />
              ))}
            </div>
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
          ) : recentTx.length === 0 ? (
            <EmptyState icon="🧾" message="本期暂无交易" />
          ) : (
            <div ref={recentListRef} className="flex flex-col">
              {recentTx.map((tx, i) => (
                <TransactionRow key={i} tx={tx} />
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
