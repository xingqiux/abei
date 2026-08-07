import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import {
  CalendarDaysIcon,
  ChartBarIcon,
  ClockIcon,
  DocumentCheckIcon,
  ExclamationTriangleIcon,
  InboxIcon,
  KeyIcon,
  SparklesIcon,
} from '@heroicons/react/24/outline'
import { ChevronRightIcon, PlusIcon } from '@heroicons/react/20/solid'
import { preferredInboxTab, type InboxTab } from '../bill-inbox/billInboxHelpers'
import gsap from 'gsap'
import {
  useAccountOverviewChart,
  useDeleteTransaction,
  useSummaryBasic,
  useTransactions,
} from '../../api/queries'
import { usePageRange } from '../../store/dateRangeStore'
import { useBudgetsData } from '../budgets/useBudgetsData'
import { formatAmount, monthRange, toDateInputValue } from '../../lib/format'
import { cashflowAmounts, summaryAmounts } from '../../lib/summary'
import { absoluteDecimalString, subtractDecimalStrings, sumDecimalStrings } from '../../lib/decimal'
import { pickTopBalanceSeries } from '../../lib/chartSeries'
import { TransactionRow } from '../../components/abaku/TransactionRow'
import { DeleteTransactionDialog } from '../../components/abaku/DeleteTransactionDialog'
import { BalanceAreaChart } from '../../components/abaku/BalanceAreaChart'
import { Skeleton } from '../../components/abaku/Skeleton'
import { EmptyState } from '../../components/abaku/EmptyState'
import { ErrorState } from '../../components/abaku/ErrorState'
import { ProgressBar } from '../../components/abaku/ProgressBar'
import { KpiCard } from '../../components/abaku/KpiCard'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { showToast } from '../../store/toastStore'
import { useRecordTxStore } from '../../store/recordTxStore'
import { FireflyApiError } from '../../api/client'
import { isEditableTransactionType } from '../record-transaction/editPayload'
import { flattenTransactionGroups, type TransactionSplitRow } from '../../lib/transactionGroup'
import { prefersReducedMotion } from '../../motion/reducedMotion'
import { useTodoCounts } from '../../hooks/useTodoCounts'

interface InboxTodoItem {
  key: string
  label: string
  tab: InboxTab
  icon: typeof InboxIcon
  count: number
}

interface OtherTodoItem {
  key: string
  label: string
  to: '/reconciliation' | '/accounts'
  view?: 'subscriptions'
  icon: typeof InboxIcon
  count: number
}

export function TodayPage() {
  const range = usePageRange('today')
  const thisMonth = useMemo(() => monthRange(new Date()), [])
  const todayRange = useMemo(() => {
    const today = toDateInputValue(new Date())
    return { start: today, end: today }
  }, [])
  const todoCounts = useTodoCounts()
  const { budgetsQuery, limitsByBudget } = useBudgetsData(thisMonth)
  const rangeSummaryQuery = useSummaryBasic(range)
  const monthlySummaryQuery = useSummaryBasic(thisMonth)
  const chartQuery = useAccountOverviewChart(range, { preselected: 'assets' })
  const recentQuery = useTransactions(todayRange, { limit: 8, page: 1, type: 'all' })
  const deleteMutation = useDeleteTransaction()
  const openRecordForm = useRecordTxStore((state) => state.openForm)
  const [pendingDelete, setPendingDelete] = useState<TransactionSplitRow | null>(null)
  const mainRef = useRef<HTMLElement>(null)

  // 需处理类优先：验证码 / 失败 / 待解析，再待审
  const inboxTodos = ([
    { key: 'code', label: '待验证码', tab: 'processing', icon: KeyIcon, count: todoCounts.needsCode },
    { key: 'failed', label: '解析失败', tab: 'processing', icon: ExclamationTriangleIcon, count: todoCounts.failed },
    { key: 'processing', label: '待处理账单', tab: 'processing', icon: ClockIcon, count: todoCounts.unprocessed },
    { key: 'parsed', label: '待审账单', tab: 'parsed', icon: DocumentCheckIcon, count: todoCounts.parsed },
  ] satisfies InboxTodoItem[]).filter((todo) => todo.count > 0)
  const otherTodos = ([
    { key: 'recon', label: '未对账', to: '/reconciliation', icon: CalendarDaysIcon, count: todoCounts.daysUnreconciled },
    { key: 'subs', label: '本月待付订阅', to: '/accounts', view: 'subscriptions', icon: SparklesIcon, count: todoCounts.dueSubscriptions },
  ] satisfies OtherTodoItem[]).filter((todo) => todo.count > 0)
  const inboxTotal = todoCounts.inboxTotal
  const inboxEntryTab = preferredInboxTab(todoCounts.processing)
  const showTodos = inboxTodos.length > 0 || otherTodos.length > 0

  const kpis = useMemo(() => {
    const summary = rangeSummaryQuery.data
    if (!summary) return null
    return {
      spent: summaryAmounts(summary, 'spent'),
      earned: summaryAmounts(summary, 'earned'),
      cashflow: cashflowAmounts(summary),
    }
  }, [rangeSummaryQuery.data])
  const balanceSeries = useMemo(
    () => pickTopBalanceSeries(chartQuery.data ?? [], 4),
    [chartQuery.data],
  )

  const limitTotal = useMemo(
    () => sumDecimalStrings(Array.from(limitsByBudget.values()).flat().map((limit) => limit.amount)),
    [limitsByBudget],
  )
  const spent = useMemo(
    () => (monthlySummaryQuery.data
      ? sumDecimalStrings(summaryAmounts(monthlySummaryQuery.data, 'spent').map((amount) => absoluteDecimalString(amount.value)))
      : '0'),
    [monthlySummaryQuery.data],
  )
  const remaining = subtractDecimalStrings(limitTotal, spent)
  const overspent = Number(remaining) < 0
  const pct = Number(limitTotal) > 0 ? (Number(spent) / Number(limitTotal)) * 100 : 0
  const noBudget = (budgetsQuery.data?.data.length ?? 0) === 0 || Number(limitTotal) <= 0
  const now = new Date()
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const daysLeft = lastDay - now.getDate()

  useEffect(() => {
    const element = mainRef.current
    if (!element || prefersReducedMotion()) return
    gsap.fromTo(element, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.22, ease: 'power2.out' })
  }, [showTodos])

  const recentRows: TransactionSplitRow[] = flattenTransactionGroups(recentQuery.data?.data ?? [])
  const pendingDeleteSplits = pendingDelete
    ? recentRows.filter((row) => row.groupId === pendingDelete.groupId).map((row) => row.tx)
    : []

  async function confirmDelete() {
    if (!pendingDelete) return
    try {
      await deleteMutation.mutateAsync(pendingDelete.groupId)
      showToast({ kind: 'success', message: '交易已移入回收站' })
      setPendingDelete(null)
    } catch (error) {
      const message = error instanceof FireflyApiError ? error.message : '移入回收站失败，请重试'
      showToast({ kind: 'error', message, duration: 6000 })
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-lg font-semibold text-[var(--text-primary)]">今天</h1>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {rangeSummaryQuery.isError ? (
          <Card padded={false} className="sm:col-span-3">
            <ErrorState message="汇总加载失败" onRetry={() => void rangeSummaryQuery.refetch()} />
          </Card>
        ) : rangeSummaryQuery.isLoading || !kpis ? (
          Array.from({ length: 3 }).map((_, index) => <Skeleton key={index} className="h-[86px]" />)
        ) : (
          <>
            <KpiCard label="本期支出" amounts={kpis.spent} semantic="expense" sublabel={`${range.start} ~ ${range.end}`} signed />
            <KpiCard label="本期收入" amounts={kpis.earned} semantic="income" sublabel={`${range.start} ~ ${range.end}`} signed />
            <KpiCard label="本期净流" amounts={kpis.cashflow} semantic="neutral" sublabel={`${range.start} ~ ${range.end}`} signed />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 items-stretch gap-3 lg:grid-cols-[minmax(0,1.7fr)_minmax(300px,1fr)]">
        <Card className="min-w-0">
          <h2 className="mb-3 text-[13px] font-semibold text-[var(--text-primary)]">账户余额趋势</h2>
          {chartQuery.isLoading ? (
            <Skeleton className="h-[170px]" />
          ) : chartQuery.isError ? (
            <ErrorState message="余额趋势加载失败" onRetry={() => void chartQuery.refetch()} />
          ) : balanceSeries.length === 0 ? (
            <EmptyState compact icon={<ChartBarIcon aria-hidden className="size-8 text-[var(--text-tertiary)]" />} message="所选范围暂无余额趋势" />
          ) : (
            <BalanceAreaChart series={balanceSeries} height={150} />
          )}
        </Card>

        <Card ref={mainRef} className="min-w-0">
          {showTodos ? (
            <>
              <h2 className="mb-2 text-[13px] font-semibold text-[var(--text-primary)]">待办</h2>
              <ul role="list" className="flex flex-col gap-0.5">
                {inboxTotal > 0 && (
                  <li>
                    <Link
                      to="/bill-inbox"
                      search={{ tab: inboxEntryTab }}
                      className="flex items-center gap-3 rounded-md px-2 py-2 text-[13px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover)]"
                    >
                      <InboxIcon aria-hidden className="size-4.5 shrink-0 text-[var(--brand-text)]" />
                      <span className="min-w-0 flex-1 truncate">账单收件箱</span>
                      <span className="font-mono tabular-nums text-[var(--text-secondary)]">{inboxTotal}</span>
                      <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-[var(--text-tertiary)]" />
                    </Link>
                    {inboxTodos.length > 0 && (
                      <ul role="list" className="ml-3 flex flex-col gap-0.5 border-l border-[var(--border-subtle)] pl-2">
                        {inboxTodos.map((todo) => {
                          const Icon = todo.icon
                          return (
                            <li key={todo.key}>
                              <Link
                                to="/bill-inbox"
                                search={{ tab: todo.tab }}
                                className="flex items-center gap-3 rounded-md px-2 py-1.5 text-[13px] text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover)]"
                              >
                                <Icon aria-hidden className="size-4 shrink-0 text-[var(--brand-text)]" />
                                <span className="min-w-0 flex-1 truncate">{todo.label}</span>
                                <span className="font-mono tabular-nums text-[var(--text-secondary)]">{todo.count}</span>
                                <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-[var(--text-tertiary)]" />
                              </Link>
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </li>
                )}
                {otherTodos.map((todo) => {
                  const Icon = todo.icon
                  return (
                    <li key={todo.key}>
                      <Link
                        to={todo.to}
                        search={todo.to === '/accounts' ? { view: todo.view } : undefined}
                        className="flex items-center gap-3 rounded-md px-2 py-2 text-[13px] text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover)]"
                      >
                        <Icon aria-hidden className="size-4.5 shrink-0 text-[var(--brand-text)]" />
                        <span className="min-w-0 flex-1 truncate">{todo.label}</span>
                        <span className="font-mono tabular-nums text-[var(--text-secondary)]">{todo.count}</span>
                        <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-[var(--text-tertiary)]" />
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </>
          ) : noBudget ? (
            <div className="flex h-full min-h-[170px] flex-col items-center justify-center gap-2 text-center">
              <p className="text-sm font-semibold text-[var(--text-primary)]">还没设月度预算</p>
              <p className="text-[12.5px] text-[var(--text-secondary)]">设好后，这里会显示本月可用额度。</p>
              <Link
                to="/accounts"
                search={{ view: 'budgets' }}
                className="mt-2 inline-flex items-center rounded-md bg-[var(--brand)] px-3 py-1.5 text-[13px] font-semibold text-[var(--brand-on)] transition-colors hover:bg-[var(--brand-hover)]"
              >
                去设预算
              </Link>
            </div>
          ) : (
            <div className="flex h-full min-h-[170px] flex-col justify-center gap-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-xs text-[var(--text-secondary)]">本月还能花</span>
                <span className={`font-mono text-[26px] font-semibold tabular-nums ${overspent ? 'text-[var(--attention)]' : 'text-[var(--text-primary)]'}`}>
                  {overspent ? '-' : ''}¥{formatAmount(remaining)}
                </span>
              </div>
              <ProgressBar pct={pct} tone={pct > 100 ? 'attention' : 'brand'} label="本月预算已用" />
              <div className="flex items-center justify-between gap-3 text-[11.5px] text-[var(--text-secondary)]">
                <span>已花 ¥{formatAmount(spent)}</span>
                <span>{daysLeft === 0 ? '今天是最后一天' : `本月还剩 ${daysLeft} 天`}</span>
              </div>
            </div>
          )}
        </Card>
      </div>

      <Card>
        <h2 className="mb-3 text-[13px] font-semibold text-[var(--text-primary)]">今日流水</h2>
        {recentQuery.isLoading ? (
          <div className="flex flex-col gap-1" role="status" aria-label="今日流水加载中">
            {Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="h-8" />)}
          </div>
        ) : recentQuery.isError ? (
          <ErrorState message="今日交易加载失败" onRetry={() => void recentQuery.refetch()} />
        ) : recentRows.length === 0 ? (
          <div className="flex min-h-20 flex-wrap items-center justify-between gap-3 px-2 py-4">
            <p className="text-sm text-[var(--text-secondary)]">今天还没有记账</p>
            <Button variant="primary" size="sm" onClick={openRecordForm}>
              <PlusIcon aria-hidden className="size-4" />
              记一笔
            </Button>
          </div>
        ) : (
          <div className="flex flex-col">
            {recentRows.map((row) => {
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
