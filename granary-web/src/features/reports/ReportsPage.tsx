import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useExpenseByAsset, useExpenseByCategory, useIncomeByRevenue, useSummaryBasic, useTransactions } from '../../api/queries'
import { KpiCard } from '../../components/granary/KpiCard'
import { CategoryBarChart } from '../../components/granary/CategoryBarChart'
import { TransactionRow } from '../../components/granary/TransactionRow'
import { Skeleton } from '../../components/granary/Skeleton'
import { EmptyState } from '../../components/granary/EmptyState'
import { addMonths, monthRange } from '../../lib/format'
import { topNWithOther } from '../../lib/insight'
import { useStaggerIn } from '../../motion/useStaggerIn'
import { useLenis } from '../../motion/useLenis'
import { MonthSwitcher } from './MonthSwitcher'

const TOP_TX_LIMIT = 250

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

function RankingCard({ title, isLoading, data }: { title: string; isLoading: boolean; data: ReturnType<typeof topNWithOther> }) {
  return (
    <Card title={title}>
      {isLoading ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-4" />
          ))}
        </div>
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

  // 首屏必须有内容（规范原则③）：用户未手动切月时，当月无任何收支就自动回退，最多找 12 个月
  const userTouchedRef = useRef(false)
  const fallbackStepsRef = useRef(0)
  useEffect(() => {
    if (userTouchedRef.current || fallbackStepsRef.current >= 12) return
    const s = summaryQuery.data
    if (!s) return
    const spent = Number(s['spent-in-CNY']?.monetary_value ?? 0)
    const earned = Number(s['earned-in-CNY']?.monetary_value ?? 0)
    if (spent === 0 && earned === 0) {
      fallbackStepsRef.current += 1
      setMonth((m) => addMonths(m, -1))
    }
  }, [summaryQuery.data])
  const categoryQuery = useExpenseByCategory(range)
  const revenueQuery = useIncomeByRevenue(range)
  const assetOutflowQuery = useExpenseByAsset(range)
  const topTxQuery = useTransactions(range, { limit: TOP_TX_LIMIT, page: 1, type: 'withdrawal' })

  const kpis = useMemo(() => {
    const s = summaryQuery.data
    if (!s) return null
    const spent = Number(s['spent-in-CNY']?.monetary_value ?? 0)
    const earned = Number(s['earned-in-CNY']?.monetary_value ?? 0)
    return { spent, earned, net: earned + spent }
  }, [summaryQuery.data])

  const categoryData = useMemo(() => topNWithOther(categoryQuery.data ?? []), [categoryQuery.data])
  const revenueData = useMemo(() => topNWithOther(revenueQuery.data ?? []), [revenueQuery.data])
  const assetOutflowData = useMemo(() => topNWithOther(assetOutflowQuery.data ?? []), [assetOutflowQuery.data])

  const topTx = useMemo(() => {
    const rows = topTxQuery.data?.data.map((g) => g.attributes.transactions[0]).filter(Boolean) ?? []
    return [...rows].sort((a, b) => Math.abs(Number(b.amount)) - Math.abs(Number(a.amount))).slice(0, 10)
  }, [topTxQuery.data])
  const topTxRef = useStaggerIn<HTMLDivElement>([topTxQuery.isSuccess, range.start])
  const lenisRef = useLenis<HTMLDivElement>()

  return (
    <div ref={lenisRef} className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-[18px]" style={{ fontWeight: 'var(--g-weight-demibold)', color: 'var(--g-ink)' }}>
          报表
        </h1>
        <MonthSwitcher
          month={month}
          onPrev={() => {
            userTouchedRef.current = true
            setMonth((m) => addMonths(m, -1))
          }}
          onNext={() => {
            userTouchedRef.current = true
            setMonth((m) => addMonths(m, 1))
          }}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {summaryQuery.isLoading || !kpis ? (
          Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-[86px]" />)
        ) : (
          <>
            <KpiCard label="本月收入" value={kpis.earned} colorVar="var(--g-income)" sublabel={`${range.start} ~ ${range.end}`} staggerIndex={0} signed />
            <KpiCard label="本月支出" value={kpis.spent} colorVar="var(--g-expense)" sublabel={`${range.start} ~ ${range.end}`} staggerIndex={1} signed />
            <KpiCard
              label="本月净额"
              value={kpis.net}
              colorVar={kpis.net >= 0 ? 'var(--g-income)' : 'var(--g-ink)'}
              sublabel={`${range.start} ~ ${range.end}`}
              staggerIndex={2}
              signed
            />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <RankingCard title="分类支出排行" isLoading={categoryQuery.isLoading} data={categoryData} />
        <RankingCard title="收入来源排行" isLoading={revenueQuery.isLoading} data={revenueData} />
        <RankingCard title="账户流出排行" isLoading={assetOutflowQuery.isLoading} data={assetOutflowData} />
      </div>

      <Card title="当月最大支出 Top 10">
        {topTxQuery.isLoading ? (
          <div className="flex flex-col gap-1">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-8" />
            ))}
          </div>
        ) : topTx.length === 0 ? (
          <EmptyState message="该月没有支出交易" />
        ) : (
          <div ref={topTxRef} className="flex flex-col">
            {topTx.map((tx, i) => (
              <TransactionRow key={i} tx={tx} />
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
