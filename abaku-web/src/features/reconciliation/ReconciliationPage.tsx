import { useEffect, useMemo, useState } from 'react'
import {
  useAssetAccounts,
  useCreateReconciliationAdjustment,
  useMarkDayReconciled,
  useReconciliationSummary,
  useAllTransactions,
} from '../../api/queries'
import { CalendarStrip } from './CalendarStrip'
import { TransactionRow } from '../../components/abaku/TransactionRow'
import { Skeleton } from '../../components/abaku/Skeleton'
import { EmptyState } from '../../components/abaku/EmptyState'
import { CelebrateOverlay } from '../../components/abaku/CelebrateOverlay'
import { Modal } from '../../components/abaku/Modal'
import { BanknotesIcon } from '@heroicons/react/24/outline'
import { formatAmount, formatMonthDay } from '../../lib/format'
import { useStaggerIn } from '../../motion/useStaggerIn'
import { showToast } from '../../store/toastStore'
import { FireflyApiError } from '../../api/client'
import { flattenTransactionGroups } from '../../lib/transactionGroup'
import { absoluteDecimalString, compareDecimalStrings, isPositiveDecimal, normalizeDecimalString } from '../../lib/decimal'
import { ErrorState } from '../../components/abaku/ErrorState'
import type { ReactNode } from 'react'

const DAYS_WINDOW = 30

function MiniKpi({ label, value, colorVar, mono = true }: { label: string; value: ReactNode; colorVar: string; mono?: boolean }) {
  return (
    <div className="rounded-[10px] p-3 bg-[var(--surface-1)]  shadow-sm">
      <div className="text-[11px] text-[var(--text-secondary)] " style={{ letterSpacing: '.04em', textTransform: 'uppercase' }}>
        {label}
      </div>
      <div className={mono ? 'font-mono tabular-nums mt-1' : 'mt-1'} style={{ fontSize: 16, fontWeight: 600, color: colorVar }}>
        {value}
      </div>
    </div>
  )
}

export function ReconciliationPage() {
  const summaryQuery = useReconciliationSummary(DAYS_WINDOW)
  const [selected, setSelected] = useState<string | null>(null)
  const [celebrating, setCelebrating] = useState(false)
  const [adjOpen, setAdjOpen] = useState(false)
  const [adjAmount, setAdjAmount] = useState('')
  const [adjAccountId, setAdjAccountId] = useState('')

  const markDay = useMarkDayReconciled()
  const createAdj = useCreateReconciliationAdjustment()
  // 对账调整只列纯资产，不混入花呗/助学贷款等负债
  const accountsQuery = useAssetAccounts({ includeLiabilities: false })
  const [adjDirection, setAdjDirection] = useState<'decrease' | 'increase'>('decrease')

  const chronoDays = useMemo(() => {
    const days = summaryQuery.data?.days ?? []
    return [...days].sort((a, b) => a.date.localeCompare(b.date))
  }, [summaryQuery.data])

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

  const txQuery = useAllTransactions(
    { start: selected ?? '', end: selected ?? '' },
    { limit: 200, type: 'all', enabled: !!selected },
  )
  const txList = flattenTransactionGroups(txQuery.data?.data ?? [])
  const txListRef = useStaggerIn<HTMLDivElement>([txQuery.isSuccess, selected])

  const selectedTotals = useMemo(() => selectedDay?.currency_totals.length
    ? selectedDay.currency_totals
    : selectedDay?.net !== null && selectedDay?.net !== undefined
      ? [{ currency_id: null, currency_code: '', currency_symbol: '', income: selectedDay.income ?? '0', expense: selectedDay.expense ?? '0', net: selectedDay.net }]
      : [], [selectedDay])
  const selectedDiffTotals = useMemo(() => selectedDay?.diff_totals.length
    ? selectedDay.diff_totals
    : selectedDay?.diff_amount
      ? [{ currency_id: null, currency_code: '', currency_symbol: '', amount: selectedDay.diff_amount }]
      : [], [selectedDay])
  const adjustmentAccounts = useMemo(() => {
    const codes = selectedDiffTotals.map((item) => item.currency_code).filter(Boolean)
    if (codes.length === 0) return accountsQuery.data ?? []
    return (accountsQuery.data ?? []).filter((account) => codes.includes(account.currencyCode))
  }, [accountsQuery.data, selectedDiffTotals])

  const lastReconciledLabel = summaryQuery.data?.last_reconciled_date
    ? `最近对账：${summaryQuery.data.last_reconciled_date}`
    : '最近对账：无记录'
  const daysUnreconciled = summaryQuery.data?.days_unreconciled ?? 0

  const hasDiff = selectedDiffTotals.length > 0
  const canMark =
    !!selectedDay && selectedDay.tx_count > 0 && (selectedDay.status === 'pending' || selectedDay.status === 'diff')

  useEffect(() => {
    if (!adjOpen || adjAccountId || adjustmentAccounts.length === 0) return
    setAdjAccountId(adjustmentAccounts[0].id)
  }, [adjAccountId, adjOpen, adjustmentAccounts])

  function openAdjustmentDialog() {
    setAdjDirection('decrease')
    setAdjAmount('')
    setAdjAccountId(adjustmentAccounts[0]?.id ?? '')
    setAdjOpen(true)
  }

  async function handleMarkDay() {
    if (!selectedDay) return
    try {
      const res = await markDay.mutateAsync(selectedDay.date)
      showToast({ message: `已标记 ${res.updated} 笔为已对账`, kind: 'success' })
      if (res.updated > 0) setCelebrating(true)
    } catch (err) {
      const message = err instanceof FireflyApiError ? err.message : '标记失败，请重试'
      showToast({ message, kind: 'error', duration: 6000 })
    }
  }

  async function handleCreateAdj() {
    if (!selectedDay) return
    try {
      if (!adjAmount.trim() || !isPositiveDecimal(adjAmount)) throw new Error('invalid amount')
    } catch {
      showToast({ message: '请输入大于 0 的调整金额', kind: 'error' })
      return
    }
    if (!adjAccountId) {
      showToast({ message: '请选择资产账户', kind: 'error' })
      return
    }
    const adjustmentAccount = adjustmentAccounts.find((account) => account.id === adjAccountId)
    if (!adjustmentAccount) {
      showToast({ message: '请选择有效的资产账户', kind: 'error' })
      return
    }
    try {
      await createAdj.mutateAsync({
        date: selectedDay.date,
        amount: normalizeDecimalString(adjAmount),
        account_id: adjAccountId,
        direction: adjDirection,
        description: `对账调整 ${selectedDay.date}（${adjDirection === 'decrease' ? '减少' : '增加'}）`,
      })
      setAdjOpen(false)
      showToast({
        message: adjDirection === 'decrease' ? '已生成调整交易（减少余额）' : '已生成调整交易（增加余额）',
        kind: 'success',
      })
    } catch (err) {
      const message = err instanceof FireflyApiError ? err.message : '创建失败，请重试'
      showToast({ message, kind: 'error', duration: 6000 })
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-[18px] font-semibold text-[var(--text-primary)] ">
          按天对账
        </h1>
        <div className="text-[12.5px] text-[var(--text-secondary)] ">
          {lastReconciledLabel} · 已 {daysUnreconciled} 天未对账
        </div>
      </div>

      <div className="rounded-[10px] p-3.5 bg-[var(--surface-1)]  shadow-sm">
        {summaryQuery.isLoading ? (
          <Skeleton className="h-[80px]" />
        ) : summaryQuery.isError ? (
          <ErrorState message="对账汇总加载失败" onRetry={() => void summaryQuery.refetch()} />
        ) : (
          <CalendarStrip days={chronoDays} selected={selected} onSelect={setSelected} />
        )}
      </div>

      {selectedDay && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-baseline gap-2">
              <span className="text-[14px] font-semibold text-[var(--text-primary)] ">
                {formatMonthDay(selectedDay.date)}
              </span>
              <span className="text-[11.5px] text-[var(--text-secondary)] ">
                {selectedDay.date}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={openAdjustmentDialog}
                className="rounded-[6px] px-3 py-1.5 text-[12.5px] bg-[var(--surface-hover)]  text-[var(--text-primary)] "

              >
                生成调整交易
              </button>
              {canMark && (
                <button
                  type="button"
                  disabled={markDay.isPending}
                  onClick={() => void handleMarkDay()}
                  className="rounded-[6px] px-3 py-1.5 text-[12.5px] disabled:opacity-50 bg-[var(--brand)]  text-white font-semibold"

                >
                  {markDay.isPending ? '标记中…' : '标记本日已对账'}
                </button>
              )}
            </div>
          </div>

          {hasDiff && (
            <div
              className="flex flex-wrap items-center justify-between gap-2 rounded-[6px] py-2.5 pl-3 pr-3.5 bg-[var(--surface-1)] "
              style={{ borderLeft: '3px solid var(--attention-mark)' }}
            >
              <span className="text-[12.5px] text-[var(--text-primary)] ">
                该日存在对账差异{' '}
                <span className="font-mono tabular-nums text-[var(--attention)] ">
                  {selectedDiffTotals.map((total) => <span key={total.currency_code || total.currency_symbol} className="mr-2">{total.currency_symbol}{formatAmount(total.amount)}{total.currency_code ? ` ${total.currency_code}` : ''}</span>)}
                </span>
                （已有 Reconciliation 调整流水）
              </span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MiniKpi label="收入" value={<>{selectedTotals.map((total) => <div key={total.currency_code || total.currency_symbol}>+{total.currency_symbol}{formatAmount(total.income)} <small>{total.currency_code}</small></div>)}</>} colorVar="var(--income)" />
            <MiniKpi label="支出" value={<>{selectedTotals.map((total) => <div key={total.currency_code || total.currency_symbol}>-{total.currency_symbol}{formatAmount(total.expense)} <small>{total.currency_code}</small></div>)}</>} colorVar="var(--danger)" />
            <MiniKpi
              label="净额"
              value={<>{selectedTotals.map((total) => { const comparison = compareDecimalStrings(total.net, '0'); return <div key={total.currency_code || total.currency_symbol}>{comparison > 0 ? '+' : comparison < 0 ? '-' : ''}{total.currency_symbol}{formatAmount(absoluteDecimalString(total.net))} <small>{total.currency_code}</small></div> })}</>}
              colorVar="var(--text-primary)"
            />
            <MiniKpi label="笔数" value={String(selectedDay.tx_count)} colorVar="var(--text-primary)" />
          </div>

          <div className="rounded-[10px] p-2 bg-[var(--surface-1)]  shadow-sm">
            {txQuery.isLoading ? (
              <div className="flex flex-col gap-1 p-2">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-8" />
                ))}
              </div>
            ) : txQuery.isError ? (
              <ErrorState message="当日交易加载失败" onRetry={() => void txQuery.refetch()} />
            ) : txList.length === 0 ? (
              <EmptyState icon={<BanknotesIcon aria-hidden className="size-9 text-[var(--text-tertiary)]" />} message="当日暂无交易" />
            ) : (
              <div ref={txListRef} className="flex flex-col">
                {txList.map((row) => (
                  <TransactionRow
                    key={`${row.groupId}-${row.tx.transaction_journal_id ?? row.splitIndex}`}
                    tx={row.tx}
                    ids={{ groupId: row.groupId, journalId: String(row.tx.transaction_journal_id ?? row.groupId) }}
                  />
                ))}
              </div>
            )}
          </div>
        </>
      )}

      <Modal
        open={adjOpen}
        onClose={() => setAdjOpen(false)}
        title="生成调整交易"
        width={420}
        footer={
          <>
            <button
              type="button"
              onClick={() => setAdjOpen(false)}
              className="rounded-[6px] px-3 py-1.5 text-[12.5px] bg-[var(--surface-hover)]  text-[var(--text-primary)] "

            >
              取消
            </button>
            <button
              type="button"
              disabled={createAdj.isPending || adjustmentAccounts.length === 0}
              onClick={() => void handleCreateAdj()}
              className="rounded-[6px] px-3 py-1.5 text-[12.5px] disabled:opacity-50 bg-[var(--brand)]  text-white font-semibold"

            >
              {createAdj.isPending ? '创建中…' : '创建'}
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-3 text-[12.5px]">
          <p style={{ color: 'var(--text-secondary)' }}>
            type=reconciliation，自动标记 reconciled。减少=资产作来源；增加=资产作目标；对侧由后端挂对账账户。
          </p>
          <div className="flex flex-col gap-1.5">
            <span style={{ color: 'var(--text-secondary)' }}>方向</span>
            <div className="flex gap-1">
              {(
                [
                  { id: 'decrease' as const, label: '减少余额' },
                  { id: 'increase' as const, label: '增加余额' },
                ] as const
              ).map((opt) => {
                const active = adjDirection === opt.id
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setAdjDirection(opt.id)}
                    className="rounded-[4px] px-2.5 py-1 text-[12px]"
                    style={{
                      background: active ? 'var(--brand)' : 'var(--surface-hover)',
                      color: active ? 'var(--color-white)' : 'var(--text-primary)',
                      fontWeight: active ? '600' : undefined,
                    }}
                  >
                    {opt.label}
                  </button>
                )
              })}
            </div>
          </div>
          <label className="flex flex-col gap-1">
            <span style={{ color: 'var(--text-secondary)' }}>金额</span>
            <input
              value={adjAmount}
              onChange={(e) => setAdjAmount(e.target.value.replace(/[^0-9.]/g, ''))}
              className="font-mono tabular-nums rounded-[6px] px-2.5 py-1.5 outline-none bg-[var(--surface-hover)]  text-[var(--text-primary)] "
              style={{ border: '1px solid var(--border-subtle)' }}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span style={{ color: 'var(--text-secondary)' }}>资产账户</span>
            <select
              value={adjAccountId}
              onChange={(e) => setAdjAccountId(e.target.value)}
              className="rounded-[6px] px-2.5 py-1.5 outline-none bg-[var(--surface-hover)]  text-[var(--text-primary)] "
              style={{ border: '1px solid var(--border-subtle)' }}
            >
              {adjustmentAccounts.length === 0 && <option value="">{hasDiff ? '没有匹配差异币种的资产账户' : '没有可用的资产账户'}</option>}
              {adjustmentAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}{a.currencyCode ? ` · ${a.currencyCode}` : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
      </Modal>

      {celebrating && <CelebrateOverlay onDone={() => setCelebrating(false)} />}
    </div>
  )
}
