import { useEffect, useMemo, useState } from 'react'
import {
  useAssetAccounts,
  useCreateReconciliationAdjustment,
  useMarkDayReconciled,
  useReconciliationSummary,
  useTransactions,
} from '../../api/queries'
import { CalendarStrip } from './CalendarStrip'
import { TransactionRow } from '../../components/granary/TransactionRow'
import { Skeleton } from '../../components/granary/Skeleton'
import { EmptyState } from '../../components/granary/EmptyState'
import { CelebrateOverlay } from '../../components/granary/CelebrateOverlay'
import { Modal } from '../../components/granary/Modal'
import emptyWalletUrl from '../../assets/lottie/empty-wallet.json?url'
import { formatAmount, formatMonthDay } from '../../lib/format'
import { useStaggerIn } from '../../motion/useStaggerIn'
import { showToast } from '../../store/toastStore'
import { FireflyApiError } from '../../api/client'

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
  const canMark =
    !!selectedDay && selectedDay.tx_count > 0 && (selectedDay.status === 'pending' || selectedDay.status === 'diff')

  useEffect(() => {
    if (!adjOpen) return
    if (selectedDay?.diff_amount) setAdjAmount(String(Math.abs(Number(selectedDay.diff_amount))))
    else setAdjAmount('')
    setAdjDirection('decrease')
    const first = accountsQuery.data?.[0]?.id ?? ''
    setAdjAccountId(first)
  }, [adjOpen, selectedDay, accountsQuery.data])

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
    const n = Number(adjAmount)
    if (!adjAmount.trim() || !Number.isFinite(n) || n <= 0) {
      showToast({ message: '请输入大于 0 的调整金额', kind: 'error' })
      return
    }
    if (!adjAccountId) {
      showToast({ message: '请选择资产账户', kind: 'error' })
      return
    }
    try {
      await createAdj.mutateAsync({
        date: selectedDay.date,
        amount: n.toFixed(2),
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
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-baseline gap-2">
              <span className="text-[14px]" style={{ fontWeight: 'var(--g-weight-demibold)', color: 'var(--g-ink)' }}>
                {formatMonthDay(selectedDay.date)}
              </span>
              <span className="text-[11.5px]" style={{ color: 'var(--g-ink-2)' }}>
                {selectedDay.date}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setAdjOpen(true)}
                className="rounded-[6px] px-3 py-1.5 text-[12.5px]"
                style={{ background: 'var(--g-surface-2)', color: 'var(--g-ink)' }}
              >
                生成调整交易
              </button>
              {canMark && (
                <button
                  type="button"
                  disabled={markDay.isPending}
                  onClick={() => void handleMarkDay()}
                  className="rounded-[6px] px-3 py-1.5 text-[12.5px] disabled:opacity-50"
                  style={{
                    background: 'var(--g-accent)',
                    color: 'var(--g-accent-ink)',
                    fontWeight: 'var(--g-weight-demibold)',
                  }}
                >
                  {markDay.isPending ? '标记中…' : '标记本日已对账'}
                </button>
              )}
            </div>
          </div>

          {hasDiff && (
            <div
              className="flex flex-wrap items-center justify-between gap-2 rounded-[6px] py-2.5 pl-3 pr-3.5"
              style={{ background: 'var(--g-surface)', borderLeft: '3px solid var(--g-danger)' }}
            >
              <span className="text-[12.5px]" style={{ color: 'var(--g-ink)' }}>
                该日存在对账差异{' '}
                <span className="font-num" style={{ color: 'var(--g-danger)' }}>
                  ¥{formatAmount(diffAmount)}
                </span>
                （已有 Reconciliation 调整流水）
              </span>
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
              className="rounded-[6px] px-3 py-1.5 text-[12.5px]"
              style={{ background: 'var(--g-surface-2)', color: 'var(--g-ink)' }}
            >
              取消
            </button>
            <button
              type="button"
              disabled={createAdj.isPending}
              onClick={() => void handleCreateAdj()}
              className="rounded-[6px] px-3 py-1.5 text-[12.5px] disabled:opacity-50"
              style={{
                background: 'var(--g-accent)',
                color: 'var(--g-accent-ink)',
                fontWeight: 'var(--g-weight-demibold)',
              }}
            >
              {createAdj.isPending ? '创建中…' : '创建'}
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-3 text-[12.5px]">
          <p style={{ color: 'var(--g-ink-2)' }}>
            type=reconciliation，自动标记 reconciled。减少=资产作来源；增加=资产作目标；对侧由后端挂对账账户。
          </p>
          <div className="flex flex-col gap-1.5">
            <span style={{ color: 'var(--g-ink-2)' }}>方向</span>
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
                      background: active ? 'var(--g-accent)' : 'var(--g-surface-2)',
                      color: active ? 'var(--g-accent-ink)' : 'var(--g-ink)',
                      fontWeight: active ? 'var(--g-weight-demibold)' : undefined,
                    }}
                  >
                    {opt.label}
                  </button>
                )
              })}
            </div>
          </div>
          <label className="flex flex-col gap-1">
            <span style={{ color: 'var(--g-ink-2)' }}>金额</span>
            <input
              value={adjAmount}
              onChange={(e) => setAdjAmount(e.target.value.replace(/[^0-9.]/g, ''))}
              className="font-num rounded-[6px] px-2.5 py-1.5 outline-none"
              style={{ background: 'var(--g-surface-2)', color: 'var(--g-ink)', border: '1px solid var(--g-border)' }}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span style={{ color: 'var(--g-ink-2)' }}>资产账户</span>
            <select
              value={adjAccountId}
              onChange={(e) => setAdjAccountId(e.target.value)}
              className="rounded-[6px] px-2.5 py-1.5 outline-none"
              style={{ background: 'var(--g-surface-2)', color: 'var(--g-ink)', border: '1px solid var(--g-border)' }}
            >
              {(accountsQuery.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
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
