import { useMemo, useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { CaretRight } from '@phosphor-icons/react'
import {
  useNetWorthAccounts,
  useRecurrences,
  useSearchTransactionsPage,
  useSummaryBasic,
  useTransactions,
} from '../../api/queries'
import { usePageRange } from '../../store/dateRangeStore'
import {
  formatAmount,
  formatDateLabel,
  formatMonthDay,
  toDateInputValue,
} from '../../lib/format'
import { cashflowAmounts, summaryAmounts, type CurrencyAmount } from '../../lib/summary'
import { absoluteDecimalString, compareDecimalStrings, sumDecimalStrings } from '../../lib/decimal'
import { daysBetween, groupRowsByDay, type CurrencyTotal, type DayGroup } from '../../lib/dayTotals'
import { previousRange, trendPercent } from '../../lib/trend'
import { nextOccurrence } from '../../lib/recurrence'
import { flattenTransactionGroups } from '../../lib/transactionGroup'
import { InsightBanner } from '../../components/abei/InsightBanner'
import { Skeleton } from '../../components/abei/Skeleton'
import { ErrorState } from '../../components/abei/ErrorState'
import { Card } from '../../components/ui/Card'
import { useTodoCounts } from '../../hooks/useTodoCounts'
import { useLockedChannels } from '../../hooks/useLockedChannels'
import { txSearch } from '../../routes/transactionSearch'

/** 同一条提醒一个会话只打扰一次 */
const INSIGHT_DISMISS_KEY = 'abaku.today.insight.dismissed'

/** 停一两天不叫断层——周末不记账很正常。超过这个数才画警示块。 */
const GAP_WARN_DAYS = 3

/** 时间线尾巴往回看多远。够长才能在停摆的账本上还找得到最后一笔 */
const TAIL_DAYS = 180

/** 尾巴上摊开几天。再多就该去交易页看了 */
const TAIL_GROUPS = 4

export function TodayPage() {
  const range = usePageRange('today')
  const prevRange = useMemo(() => previousRange(range), [range])
  const today = useMemo(() => toDateInputValue(new Date()), [])
  const tailRange = useMemo(() => {
    const end = new Date()
    const start = new Date(end)
    start.setDate(start.getDate() - TAIL_DAYS)
    return { start: toDateInputValue(start), end: toDateInputValue(end) }
  }, [])

  const todo = useTodoCounts()
  const lockedChannels = useLockedChannels()
  const rangeSummaryQuery = useSummaryBasic(range)
  const prevSummaryQuery = useSummaryBasic(prevRange)
  const accountsQuery = useNetWorthAccounts()
  const recurrencesQuery = useRecurrences()
  const tailQuery = useTransactions(tailRange, { limit: 40, page: 1, type: 'all' })
  // 未分类总数：只要 meta 里那个 total，拉一行就够
  const uncategorizedQuery = useSearchTransactionsPage('has_no_category:true', { limit: 1, page: 1 })
  const uncategorized = uncategorizedQuery.data?.meta?.pagination?.total ?? 0

  const kpis = useMemo(() => {
    const summary = rangeSummaryQuery.data
    if (!summary) return null
    return {
      spent: summaryAmounts(summary, 'spent'),
      earned: summaryAmounts(summary, 'earned'),
      cashflow: cashflowAmounts(summary),
    }
  }, [rangeSummaryQuery.data])

  const prevKpis = useMemo(() => {
    const summary = prevSummaryQuery.data
    if (!summary) return null
    return { spent: summaryAmounts(summary, 'spent'), earned: summaryAmounts(summary, 'earned') }
  }, [prevSummaryQuery.data])

  const emptyPeriod = !!kpis && allZero(kpis.spent) && allZero(kpis.earned)

  /** 资产 / 负债 / 净资产：口径一次说全，不留「这个数含不含信用卡」这种疑问 */
  const netWorth = useMemo(() => {
    const accounts = accountsQuery.data ?? []
    if (accounts.length === 0) return null
    const symbol = accounts.find((account) => account.attributes.currency_symbol)?.attributes.currency_symbol ?? '¥'
    const balancesOf = (predicate: (type: string) => boolean) =>
      accounts
        .filter((account) => predicate(account.attributes.type.toLowerCase()) && account.attributes.include_net_worth !== false)
        .map((account) => account.attributes.current_balance ?? '0')
    const assets = sumDecimalStrings(balancesOf((type) => type === 'asset'))
    const liabilities = sumDecimalStrings(balancesOf((type) => type !== 'asset'))
    return { symbol, assets, liabilities, net: sumDecimalStrings([assets, liabilities]) }
  }, [accountsQuery.data])

  /** 账本最后一笔：所有资产/负债账户里最近一次有动静的日期 */
  const lastActivity = useMemo(() => {
    let latest: string | null = null
    for (const account of accountsQuery.data ?? []) {
      const day = account.attributes.last_activity?.slice(0, 10)
      if (day && (!latest || day > latest)) latest = day
    }
    return latest
  }, [accountsQuery.data])

  /** 时间线的下半截：今天有什么、最后一笔在哪天、再往前几天 */
  const tail = useMemo(() => {
    const rows = flattenTransactionGroups(tailQuery.data?.data ?? [])
    const sorted = [...rows].sort((a, b) => b.tx.date.localeCompare(a.tx.date))
    const groups = groupRowsByDay(sorted)
    const todayGroup = groups.find((group) => group.day === today) ?? null
    const past = groups.filter((group) => group.day < today)
    return { todayGroup, lastGroup: past[0] ?? null, earlier: past.slice(1, 1 + TAIL_GROUPS) }
  }, [tailQuery.data, today])

  /** 账本停摆多少天。账户接口的 last_activity 比这 180 天窗口更权威，优先用它 */
  const lastEntryDay = lastActivity ?? tail.lastGroup?.day ?? null
  const gapDays = lastEntryDay ? daysBetween(lastEntryDay, today) : 0
  const showGap = gapDays >= GAP_WARN_DAYS

  /** 未来 7 天要扣的周期账（订阅、房租这类），远的在上、近的在下 */
  const upcoming = useMemo(() => {
    const list = recurrencesQuery.data?.data ?? []
    const now = new Date()
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const limit = new Date(start)
    limit.setDate(limit.getDate() + 7)
    const hits: { title: string; day: string }[] = []
    for (const recurrence of list) {
      if (recurrence.attributes.active === false) continue
      const next = nextOccurrence(recurrence, start)
      if (next && next <= limit) hits.push({ title: recurrence.attributes.title, day: toDateInputValue(next) })
    }
    return hits.sort((a, b) => b.day.localeCompare(a.day)).slice(0, 3)
  }, [recurrencesQuery.data])

  /* 顶部提醒条：支出环比动静超过 10% 才开口，说一句就够 */
  const spentPct = kpis && prevKpis && !emptyPeriod ? trendPercent(kpis.spent, prevKpis.spent) : null
  const bannerMessage =
    spentPct !== null && Math.abs(spentPct) >= 10
      ? `本期支出较上期${spentPct < 0 ? '减少' : '增加'} ${Math.abs(spentPct)}%`
      : null
  const [dismissedMessage, setDismissedMessage] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(INSIGHT_DISMISS_KEY)
    } catch {
      return null
    }
  })
  const showBanner = bannerMessage !== null && bannerMessage !== dismissedMessage

  const todos = [
    todo.importable > 0 && { key: 'importable', n: todo.importable, label: '笔待入账', to: '/bill-inbox' as const },
    todo.attention > 0 && { key: 'attention', n: todo.attention, label: '笔待确认', to: '/bill-inbox' as const },
    lockedChannels.length > 0 && { key: 'locked', n: lockedChannels.length, label: '个渠道要密码', to: '/bill-inbox' as const },
    uncategorized > 0 && { key: 'uncat', n: uncategorized, label: '笔未分类', to: '/transactions' as const },
  ].filter((item): item is { key: string; n: number; label: string; to: '/bill-inbox' | '/transactions' } => !!item)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h1 className="text-lg font-semibold text-[var(--text-primary)]">概况</h1>
        <span className="num text-xs text-[var(--text-secondary)]">{formatDateLabel(today)}</span>
      </div>

      {showBanner && bannerMessage && (
        <InsightBanner
          message={bannerMessage}
          onClose={() => {
            try {
              sessionStorage.setItem(INSIGHT_DISMISS_KEY, bannerMessage)
            } catch {
              /* 隐私模式存不进就算了，本次渲染周期内也不再出现 */
            }
            setDismissedMessage(bannerMessage)
          }}
        />
      )}

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[236px_minmax(0,1fr)]">
        {/* ── 左列：常驻数字，不参与叙事 ── */}
        <aside className="flex min-w-0 flex-col gap-4">
          <Card className="flex flex-col gap-3">
            {accountsQuery.isLoading ? (
              <Skeleton className="h-[104px]" />
            ) : accountsQuery.isError ? (
              <ErrorState message="账户余额加载失败" error={accountsQuery.error} onRetry={() => void accountsQuery.refetch()} />
            ) : netWorth ? (
              <>
                <Figure cap="净资产" value={signedMoney(netWorth.symbol, netWorth.net)} size="lg" />
                <div className="flex flex-col gap-2">
                  <Meter
                    label="资产"
                    text={`${netWorth.symbol}${formatAmount(netWorth.assets)}`}
                    ratio={meterRatio(netWorth.assets, netWorth.liabilities)}
                    color="var(--chart-1)"
                  />
                  {/* 负债账户余额本来就是负数，这里显示欠了多少，不重复一个负号 */}
                  <Meter
                    label="负债"
                    text={`${netWorth.symbol}${formatAmount(netWorth.liabilities)}`}
                    ratio={meterRatio(netWorth.liabilities, netWorth.assets)}
                    color="var(--chart-3)"
                  />
                </div>
              </>
            ) : (
              <p className="text-[12.5px] text-[var(--text-secondary)]">还没有账户</p>
            )}
          </Card>

          <Card className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium tracking-wide text-[var(--text-secondary)] uppercase">
              本期
            </span>
            {rangeSummaryQuery.isLoading || !kpis ? (
              <Skeleton className="h-[44px]" />
            ) : emptyPeriod ? (
              <>
                <span className="num text-xl font-semibold text-[var(--text-secondary)]">—</span>
                <p className="text-[11.5px] text-[var(--text-secondary)]">本期无已入账交易</p>
              </>
            ) : (
              <>
                <AmountLines amounts={kpis.cashflow} className="text-xl font-semibold" />
                <p className="text-[11.5px] text-[var(--text-secondary)]">
                  支出 {plainAmounts(kpis.spent)} · 收入 {plainAmounts(kpis.earned)}
                </p>
              </>
            )}
          </Card>

          <Card className="flex flex-col gap-2">
            <span className="text-[11px] font-medium tracking-wide text-[var(--text-secondary)] uppercase">
              待处理
            </span>
            {todo.isLoading ? (
              <Skeleton className="h-[72px]" />
            ) : todos.length === 0 ? (
              <p className="text-[12.5px] text-[var(--text-secondary)]">无待处理事项</p>
            ) : (
              <ul aria-label="待处理" className="flex flex-col gap-1">
                {todos.map((item) => (
                  <li key={item.key}>
                    <Link
                      to={item.to}
                      search={item.to === '/transactions' ? txSearch({ view: 'uncategorized' }) : undefined}
                      className="-mx-1 flex items-baseline gap-2 rounded-md px-1 py-1 transition-colors hover:bg-[var(--surface-hover)]"
                    >
                      <span className="num min-w-8 text-[15px] font-semibold text-[var(--text-primary)]">{item.n}</span>
                      <span className="text-[12.5px] text-[var(--text-secondary)]">{item.label}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {todo.total > 0 && (
              <Link
                to="/bill-inbox"
                className="mt-1 inline-flex items-center justify-center gap-1 rounded-md bg-[var(--brand)] px-3 py-1.5 text-[13px] font-semibold text-[var(--brand-on)] transition-colors hover:bg-[var(--brand-hover)]"
              >
                处理收件箱
                <CaretRight aria-hidden className="size-4" />
              </Link>
            )}
          </Card>
        </aside>

        {/* ── 右列：时间线。上半截是未来的周期账，下半截是已入账的 ── */}
        <Card className="flex min-w-0 flex-col gap-4">
          <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">时间线</h2>

          {tailQuery.isError ? (
            <ErrorState message="交易加载失败" error={tailQuery.error} onRetry={() => void tailQuery.refetch()} />
          ) : tailQuery.isLoading ? (
            <div className="flex flex-col gap-2" role="status" aria-label="时间线加载中">
              {Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-12" />)}
            </div>
          ) : (
            <ol className="flex flex-col gap-3">
              {upcoming.map((item) => (
                <TimelineItem
                  key={`${item.title}-${item.day}`}
                  day={item.day}
                  today={today}
                  title={item.title}
                  meta="周期扣款"
                />
              ))}

              <TimelineItem
                day={today}
                today={today}
                node="now"
                title={tail.todayGroup ? `今天已入账 ${tail.todayGroup.rows.length} 笔` : '今天暂无入账'}
                meta={
                  tail.todayGroup ? undefined : todo.total > 0 ? `收件箱待处理 ${todo.total} 笔` : '收件箱为空'
                }
                amount={tail.todayGroup?.totals}
                action={
                  !tail.todayGroup && todo.total > 0 ? (
                    <Link
                      to="/bill-inbox"
                      className="inline-flex shrink-0 items-center gap-0.5 text-[12.5px] font-medium text-[var(--brand-text)] underline-offset-2 hover:underline"
                    >
                      去入账
                      <CaretRight aria-hidden className="size-3.5" />
                    </Link>
                  ) : undefined
                }
              />

              {showGap && lastEntryDay && (
                <li className="grid grid-cols-[52px_16px_minmax(0,1fr)] items-start gap-2">
                  <span aria-hidden />
                  <Rail node="warn" />
                  <div
                    className="rounded-lg border border-dashed border-[var(--attention-mark)] px-3 py-2.5"
                    style={{
                      background:
                        'repeating-linear-gradient(135deg, var(--attention-soft) 0 8px, transparent 8px 16px)',
                    }}
                  >
                    <p className="text-[13px] font-semibold text-[var(--attention)]">
                      <span className="num">{gapDays}</span> 天无入账
                    </p>
                    {/* 收件箱笔数在上面那个「今天」节点已经写过，这里不重复 */}
                    <p className="text-[11.5px] text-[var(--attention)]">这段时间没有流水记录</p>
                  </div>
                </li>
              )}

              {tail.lastGroup ? (
                <TimelineItem
                  day={tail.lastGroup.day}
                  today={today}
                  title="账本最后一笔"
                  meta={tail.lastGroup.rows[0]?.tx.description}
                  amount={tail.lastGroup.totals}
                />
              ) : lastEntryDay ? (
                <TimelineItem day={lastEntryDay} today={today} title="账本最后一笔" meta="早于最近 180 天" />
              ) : (
                <TimelineItem day={today} today={today} title="账本暂无交易" />
              )}
            </ol>
          )}

          {tail.earlier.length > 0 && (
            <>
              <hr className="border-t border-[var(--border-subtle)]" />
              <div className="flex flex-col">
                <span className="mb-1 text-[11px] font-medium tracking-wide text-[var(--text-secondary)] uppercase">
                  再往前
                </span>
                {tail.earlier.map((group) => (
                  <EarlierDayRow key={group.day} group={group} />
                ))}
                <Link
                  to="/transactions"
                  search={txSearch()}
                  className="mt-2 inline-flex items-center gap-0.5 self-start text-[12.5px] font-medium text-[var(--brand-text)] underline-offset-2 hover:underline"
                >
                  到交易页看全部
                  <CaretRight aria-hidden className="size-3.5" />
                </Link>
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  )
}

/** 一期全是 0（或压根没有数）——不是「花了 0 元」，是「还没记账」 */
function allZero(amounts: CurrencyAmount[]): boolean {
  return amounts.every((amount) => /^[-+]?0(?:\.0*)?$/.test(amount.value.trim()))
}

/** formatAmount 只给绝对值，净资产是负的时候那个负号不能丢 */
function signedMoney(symbol: string, value: string): string {
  const body = `${symbol}${formatAmount(value)}`
  return value.trim().startsWith('-') ? `-${body}` : body
}

/** 量条长度：跟另一边比，谁大谁占满 */
function meterRatio(value: string, other: string): number {
  const self = Math.abs(Number(value))
  const max = Math.max(self, Math.abs(Number(other)))
  if (!Number.isFinite(self) || !Number.isFinite(max) || max === 0) return 0
  return Math.min(1, self / max)
}

function plainAmounts(amounts: CurrencyAmount[]): string {
  if (amounts.length === 0) return '--'
  return amounts.map((amount) => `${amount.symbol}${formatAmount(amount.value)}`).join(' / ')
}

function Figure({ cap, value, size = 'md' }: { cap: string; value: string; size?: 'md' | 'lg' }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] font-medium tracking-wide text-[var(--text-secondary)] uppercase">{cap}</span>
      <span className={`num font-semibold text-[var(--text-primary)] ${size === 'lg' ? 'text-2xl' : 'text-lg'}`}>
        {value}
      </span>
    </div>
  )
}

function Meter({ label, text, ratio, color }: { label: string; text: string; ratio: number; color: string }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-[var(--text-secondary)]">{label}</span>
        <span className="num text-xs text-[var(--text-primary)]">{text}</span>
      </div>
      <span className="block h-1.5 overflow-hidden rounded-full bg-[var(--surface-0)]">
        <span
          aria-hidden
          className="block h-full rounded-full"
          style={{ width: `${Math.round(ratio * 100)}%`, background: color }}
        />
      </span>
    </div>
  )
}

/** 多币种就并排列，不换算 */
function AmountLines({ amounts, className = '' }: { amounts: CurrencyAmount[]; className?: string }) {
  if (amounts.length === 0) return <span className={`num ${className} text-[var(--text-secondary)]`}>--</span>
  return (
    <span className="flex flex-wrap items-baseline gap-x-3">
      {amounts.map((amount) => (
        <SignedNumber key={amount.code} symbol={amount.symbol} value={amount.value} className={className} />
      ))}
    </span>
  )
}

/** 正数记收入色（红），负数用正文色，0 用次要色——跟交易行是同一套说法 */
function SignedNumber({ symbol, value, className = '' }: { symbol: string; value: string; className?: string }) {
  const comparison = compareDecimalStrings(value, '0')
  const tone =
    comparison > 0
      ? 'text-[var(--income)]'
      : comparison < 0
        ? 'text-[var(--text-primary)]'
        : 'text-[var(--text-secondary)]'
  return (
    <span className={`num ${tone} ${className}`}>
      {comparison > 0 ? '+' : comparison < 0 ? '-' : ''}
      {symbol}
      {formatAmount(absoluteDecimalString(value))}
    </span>
  )
}

function Rail({ node = 'plain' }: { node?: 'plain' | 'now' | 'warn' }) {
  const dot =
    node === 'now'
      ? 'bg-[var(--brand)]'
      : node === 'warn'
        ? 'bg-[var(--attention-mark)]'
        : 'bg-[var(--border-strong)]'
  return (
    <span aria-hidden className="flex h-full flex-col items-center pt-1.5">
      <span className={`size-2 shrink-0 rounded-full ${dot}`} />
      <span className="mt-1 w-px flex-1 bg-[var(--border-subtle)]" />
    </span>
  )
}

function TimelineItem({
  day,
  today,
  title,
  meta,
  amount,
  action,
  node = 'plain',
}: {
  day: string
  today: string
  title: string
  meta?: string
  amount?: CurrencyTotal[]
  action?: ReactNode
  node?: 'plain' | 'now' | 'warn'
}) {
  return (
    <li className="grid grid-cols-[52px_16px_minmax(0,1fr)] items-start gap-2">
      <div className="text-right">
        <div className="num text-xs text-[var(--text-primary)]">{formatMonthDay(day)}</div>
        <div className="text-[10.5px] text-[var(--text-tertiary)]">{relativeDayLabel(day, today)}</div>
      </div>
      <Rail node={node} />
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--text-primary)]">{title}</span>
          {amount?.map((total) => (
            <SignedNumber key={total.symbol} symbol={total.symbol} value={total.amount} className="text-[13px] font-semibold" />
          ))}
          {action}
        </div>
        {meta && <p className="truncate text-[11.5px] text-[var(--text-tertiary)]">{meta}</p>}
      </div>
    </li>
  )
}

function EarlierDayRow({ group }: { group: DayGroup }) {
  const first = group.rows[0]
  return (
    <div className="flex min-h-9 items-center gap-2 rounded-md px-1 text-[12.5px]">
      <span className="num w-12 shrink-0 text-[var(--text-secondary)]">{formatMonthDay(group.day)}</span>
      <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">
        {first?.tx.description}
        {group.rows.length > 1 && <span className="text-[var(--text-tertiary)]"> 等 {group.rows.length} 笔</span>}
      </span>
      {group.totals.map((total) => (
        <SignedNumber key={total.symbol} symbol={total.symbol} value={total.amount} className="shrink-0 font-semibold" />
      ))}
    </div>
  )
}

/** 今天 / 昨天 / N 天前 / N 天后。再远就不说了，日期本身够用 */
function relativeDayLabel(day: string, today: string): string {
  const diff = daysBetween(day, today)
  if (diff === 0) return '今天'
  if (diff === 1) return '昨天'
  if (diff === -1) return '明天'
  if (diff > 0) return `${diff} 天前`
  return `${-diff} 天后`
}
