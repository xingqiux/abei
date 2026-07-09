import { useEffect, useMemo, useState } from 'react'
import { useReconciliationSummary, useTransactions } from '../../api/queries'
import { CalendarStrip } from './CalendarStrip'
import { TransactionRow } from '../../components/granary/TransactionRow'
import { Skeleton } from '../../components/granary/Skeleton'
import { EmptyState } from '../../components/granary/EmptyState'
import { CelebrateOverlay } from '../../components/granary/CelebrateOverlay'
import emptyWalletUrl from '../../assets/lottie/empty-wallet.json?url'
import { formatAmount, formatMonthDay } from '../../lib/format'
import { useStaggerIn } from '../../motion/useStaggerIn'

const DAYS_WINDOW = 30

function MiniKpi({ label, value, colorVar, mono = true }: { label: string; value: string; colorVar: string; mono?: boolean }) {
  return (
    <div className="rounded-[10px] p-3" style={{ background: 'var(--g-surface)', boxShadow: 'var(--g-shadow)' }}>
      <div className="text-[11px]" style={{ color: 'var(--g-ink-2)', letterSpacing: '.04em', textTransform: 'uppercase' }}>
        {label}
      </div>
      <div className={mono ? 'font-num mt-1' : 'mt-1'} style={{ fontSize: 16, fontWeight: 600, color: colorVar }}>
        {value}
      </div>
    </div>
  )
}

export function ReconciliationPage() {
  const summaryQuery = useReconciliationSummary(DAYS_WINDOW)
  const [selected, setSelected] = useState<string | null>(null)
  const [celebrating, setCelebrating] = useState(false)

  // 接口按倒序（今天在前）返回；日历带按时间正序（旧→新）展示更贴近日历直觉
  const chronoDays = useMemo(() => {
    const days = summaryQuery.data?.days ?? []
    return [...days].sort((a, b) => a.date.localeCompare(b.date))
  }, [summaryQuery.data])

  // 默认选中最近一个有交易的日子；若都没有交易则选窗口内最后一天（今天）
  useEffect(() => {
    if (selected || chronoDays.length === 0) return
    const lastWithTx = [...chronoDays].reverse().find((d) => d.tx_count > 0)
    setSelected((lastWithTx ?? chronoDays[chronoDays.length - 1]).date)
  }, [chronoDays, selected])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (chronoDays.length === 0) return
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      const target = e.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return

      setSelected((current) => {
        const idx = chronoDays.findIndex((d) => d.date === current)
        if (idx === -1) return current
        const nextIdx = e.key === 'ArrowLeft' ? idx - 1 : idx + 1
        if (nextIdx < 0 || nextIdx >= chronoDays.length) return current
        return chronoDays[nextIdx].date
      })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [chronoDays])

  const selectedDay = useMemo(
    () => chronoDays.find((d) => d.date === selected) ?? null,
    [chronoDays, selected],
  )

  const txQuery = useTransactions(
    { start: selected ?? '', end: selected ?? '' },
    { limit: 200, page: 1, type: 'all', enabled: !!selected },
  )
  const txList = txQuery.data?.data.map((g) => g.attributes.transactions[0]).filter(Boolean) ?? []
  const txListRef = useStaggerIn<HTMLDivElement>([txQuery.isSuccess, selected])

  const lastReconciledLabel = summaryQuery.data?.last_reconciled_date
    ? `最近对账：${summaryQuery.data.last_reconciled_date}`
    : '最近对账：无记录'
  const daysUnreconciled = summaryQuery.data?.days_unreconciled ?? 0

  const diffAmount = selectedDay?.diff_amount ? Number(selectedDay.diff_amount) : 0
  const hasDiff = !!selectedDay?.diff_amount && diffAmount !== 0

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-[18px]" style={{ fontWeight: 'var(--g-weight-demibold)', color: 'var(--g-ink)' }}>
          按天对账
        </h1>
        <div className="text-[12.5px]" style={{ color: 'var(--g-ink-2)' }}>
          {lastReconciledLabel} · 已 {daysUnreconciled} 天未对账
        </div>
      </div>

      <div className="rounded-[10px] p-3.5" style={{ background: 'var(--g-surface)', boxShadow: 'var(--g-shadow)' }}>
        {summaryQuery.isLoading ? (
          <Skeleton className="h-[80px]" />
        ) : (
          <CalendarStrip days={chronoDays} selected={selected} onSelect={setSelected} />
        )}
      </div>

      {selectedDay && (
        <>
          <div className="flex items-baseline gap-2">
            <span className="text-[14px]" style={{ fontWeight: 'var(--g-weight-demibold)', color: 'var(--g-ink)' }}>
              {formatMonthDay(selectedDay.date)}
            </span>
            <span className="text-[11.5px]" style={{ color: 'var(--g-ink-2)' }}>
              {selectedDay.date}
            </span>
          </div>

          {hasDiff && (
            <div
              className="flex flex-wrap items-center justify-between gap-2 rounded-[6px] py-2.5 pl-3 pr-3.5"
              style={{ background: 'var(--g-surface)', borderLeft: '3px solid var(--g-danger)' }}
            >
              <span className="text-[12.5px]" style={{ color: 'var(--g-ink)' }}>
                该日存在对账差异 <span className="font-num" style={{ color: 'var(--g-danger)' }}>¥{formatAmount(diffAmount)}</span>
              </span>
              <button
                type="button"
                disabled
                className="shrink-0 rounded-[6px] px-3 py-1.5 text-[12.5px] disabled:opacity-60"
                style={{ background: 'var(--g-surface-2)', color: 'var(--g-ink-2)', cursor: 'not-allowed' }}
              >
                生成调整交易（待实现）
              </button>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MiniKpi label="收入" value={`+¥${formatAmount(selectedDay.income)}`} colorVar="var(--g-income)" />
            <MiniKpi label="支出" value={`-¥${formatAmount(selectedDay.expense)}`} colorVar="var(--g-expense)" />
            <MiniKpi
              label="净额"
              value={`${Number(selectedDay.net) >= 0 ? '+' : '-'}¥${formatAmount(selectedDay.net)}`}
              colorVar={Number(selectedDay.net) >= 0 ? 'var(--g-income)' : 'var(--g-expense)'}
            />
            <MiniKpi label="笔数" value={String(selectedDay.tx_count)} colorVar="var(--g-ink)" />
          </div>

          <div className="rounded-[10px] p-2" style={{ background: 'var(--g-surface)', boxShadow: 'var(--g-shadow)' }}>
            {txQuery.isLoading ? (
              <div className="flex flex-col gap-1 p-2">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-8" />
                ))}
              </div>
            ) : txList.length === 0 ? (
              <EmptyState lottieSrc={emptyWalletUrl} message="当日暂无交易" />
            ) : (
              <div ref={txListRef} className="flex flex-col">
                {txList.map((tx, i) => (
                  <TransactionRow key={i} tx={tx} />
                ))}
              </div>
            )}
          </div>
        </>
      )}

      <div className="flex justify-center pt-2">
        <button
          type="button"
          onClick={() => setCelebrating(true)}
          className="rounded-[6px] px-3 py-1.5 text-[12.5px]"
          style={{ background: 'var(--g-surface-2)', color: 'var(--g-ink-2)', border: 'none', cursor: 'pointer' }}
        >
          预览庆祝动效（对账清零时触发）
        </button>
      </div>
      {celebrating && <CelebrateOverlay onDone={() => setCelebrating(false)} />}
    </div>
  )
}
