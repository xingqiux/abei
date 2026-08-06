import { useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeftIcon, BanknotesIcon, ChartBarIcon } from '@heroicons/react/24/outline'
import {
  useAccount,
  useAccountOverviewChart,
  useDeleteAccount,
  useDeleteTransaction,
  useInfiniteAccountTransactions,
} from '../../api/queries'
import { getAccountTransactions } from '../../api/firefly'
import { useDateRangeStore } from '../../store/dateRangeStore'
import { BalanceAreaChart } from '../../components/abaku/BalanceAreaChart'
import { TransactionRow } from '../../components/abaku/TransactionRow'
import { DeleteTransactionDialog } from '../../components/abaku/DeleteTransactionDialog'
import { Skeleton } from '../../components/abaku/Skeleton'
import { EmptyState } from '../../components/abaku/EmptyState'
import { formatAmount, formatMonthDay } from '../../lib/format'
import { toBalanceSeries } from '../../lib/chartSeries'
import { useStaggerIn } from '../../motion/useStaggerIn'
import { showToast } from '../../store/toastStore'
import { FireflyApiError } from '../../api/client'
import { isEditableTransactionType } from '../record-transaction/editPayload'
import { flattenTransactionGroups, type TransactionSplitRow } from '../../lib/transactionGroup'
import { compareDecimalStrings } from '../../lib/decimal'
import { ErrorState } from '../../components/abaku/ErrorState'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { Field, Input } from '../../components/ui/Field'

/** 账户流水每页条数；偏小以便「加载更多」在常见数据量下可用，并便于分页失效回归。 */
const PAGE_SIZE = 20

const TYPE_LABEL: Record<string, string> = {
  asset: '资产',
  expense: '支出',
  revenue: '收入',
  liability: '负债',
  liabilities: '负债',
  loan: '贷款',
  debt: '债务',
  mortgage: '抵押',
  cash: '现金',
}

/** 带标题的区块，页面里三处都一样：共享 Card + 一行 h2 */
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <h2 className="mb-3 text-[11px] font-medium tracking-wide text-[var(--text-tertiary)] uppercase">{title}</h2>
      {children}
    </Card>
  )
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-[12.5px]">
      <dt className="text-[var(--text-secondary)]">{label}</dt>
      <dd className="min-w-0 text-right text-[var(--text-primary)]">{children}</dd>
    </div>
  )
}

type LoadedRow = TransactionSplitRow

export function AccountDetailPage() {
  const params = useParams({ strict: false })
  const navigate = useNavigate()
  const accountId = String(params.accountId ?? '')
  const range = useDateRangeStore()
  const rangeLabel = `${formatMonthDay(range.start)} → ${formatMonthDay(range.end)}`

  const accountQuery = useAccount(accountId)
  const chartQuery = useAccountOverviewChart(range, {
    accounts: [accountId],
    enabled: !!accountId,
  })
  const [pendingDelete, setPendingDelete] = useState<LoadedRow | null>(null)
  const [confirmName, setConfirmName] = useState('')

  const txQuery = useInfiniteAccountTransactions(accountId, range, { limit: PAGE_SIZE })
  const deleteMutation = useDeleteTransaction()
  const deleteAccountMutation = useDeleteAccount()

  const allTimeCount = useQuery({
    queryKey: ['account-tx-count', accountId],
    queryFn: async () => {
      const page = await getAccountTransactions(accountId, { start: '2000-01-01', end: '2100-01-01' }, { limit: 1 })
      return page.meta?.pagination?.total ?? 0
    },
    enabled: !!accountId,
  })

  const rows: LoadedRow[] = useMemo(() => {
    const pages = txQuery.data?.pages ?? []
    return flattenTransactionGroups(pages.flatMap((page) => page.data))
  }, [txQuery.data])

  const totalTx = txQuery.data?.pages[0]?.meta?.pagination?.total
  const canLoadMore = !!txQuery.hasNextPage
  const pendingDeleteSplits = pendingDelete
    ? rows.filter((row) => row.groupId === pendingDelete.groupId).map((row) => row.tx)
    : []
  const listRef = useStaggerIn<HTMLDivElement>([txQuery.isSuccess && (txQuery.data?.pages.length ?? 0) === 1])

  const balanceSeries = useMemo(() => {
    const raw = chartQuery.data ?? []
    if (raw.length === 0) return []
    const series = toBalanceSeries(raw[0])
    return series.points.length > 0 ? [series] : []
  }, [chartQuery.data])

  const account = accountQuery.data?.data
  const attrs = account?.attributes
  const symbol = attrs?.currency_symbol ?? attrs?.currency_code ?? ''
  const balance = attrs?.current_balance ?? '0'
  const typeLabel = attrs ? (TYPE_LABEL[attrs.type] ?? attrs.type) : ''
  const tail = attrs?.account_number
    ? attrs.account_number.slice(-4)
    : attrs?.iban
      ? attrs.iban.slice(-4)
      : null

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

  async function confirmDeleteAccount() {
    try {
      await deleteAccountMutation.mutateAsync(accountId)
      showToast({ kind: 'success', message: '账户已删除' })
      void navigate({ to: '/accounts' })
    } catch (err) {
      showToast({ kind: 'error', message: err instanceof FireflyApiError ? err.message : '删除失败', duration: 6000 })
    }
  }

  if (accountQuery.isError) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <ErrorState message="账户加载失败或不存在" onRetry={() => void accountQuery.refetch()} />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <BackLink />
          {accountQuery.isLoading || !attrs ? (
            <Skeleton className="h-7 w-40" />
          ) : (
            <>
              <h1 className="truncate text-lg font-semibold text-[var(--text-primary)]">{attrs.name}</h1>
              <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
                <span>{typeLabel}</span>
                {attrs.active === false && <Badge tone="attention">已停用</Badge>}
                {tail && <span className="font-mono tabular-nums">•••• {tail}</span>}
                <span>· {rangeLabel}</span>
              </div>
            </>
          )}
        </div>
        {attrs && (
          <div className="text-right">
            <div className="text-[11px] tracking-wide text-[var(--text-tertiary)] uppercase">当前余额</div>
            <div
              className={`mt-0.5 font-mono text-xl font-semibold tabular-nums ${
                compareDecimalStrings(balance, '0') < 0 ? 'text-[var(--danger)]' : 'text-[var(--text-primary)]'
              }`}
            >
              {symbol}
              {formatAmount(balance)}
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 min-[900px]:grid-cols-[0.9fr_1.1fr]">
        <Panel title="基本信息">
          {accountQuery.isLoading || !attrs ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-5" />
              ))}
            </div>
          ) : (
            <dl className="flex flex-col">
              <InfoRow label="类型">{typeLabel}</InfoRow>
              <InfoRow label="币种">
                <span className="font-mono tabular-nums">
                  {attrs.currency_code ?? '—'} {symbol}
                </span>
              </InfoRow>
              {attrs.opening_balance != null && attrs.opening_balance !== '' && (
                <InfoRow label="初始余额">
                  <span className="font-mono tabular-nums">
                    {symbol}
                    {formatAmount(attrs.opening_balance)}
                    {attrs.opening_balance_date && (
                      <span className="text-[var(--text-secondary)]"> · {attrs.opening_balance_date.slice(0, 10)}</span>
                    )}
                  </span>
                </InfoRow>
              )}
              <InfoRow label="最近活动">
                <span className="font-mono tabular-nums">
                  {attrs.last_activity ? attrs.last_activity.slice(0, 10) : '—'}
                </span>
              </InfoRow>
              {attrs.account_role && (
                <InfoRow label="角色">
                  <span className="font-mono tabular-nums text-[11.5px]">{attrs.account_role}</span>
                </InfoRow>
              )}
              {attrs.notes && (
                <InfoRow label="备注">
                  <span className="text-[12px] leading-relaxed">{attrs.notes}</span>
                </InfoRow>
              )}
            </dl>
          )}
        </Panel>

        <Panel title="余额趋势">
          {chartQuery.isLoading ? (
            <Skeleton className="h-[200px]" />
          ) : chartQuery.isError ? (
            <ErrorState message="余额趋势加载失败" onRetry={() => void chartQuery.refetch()} />
          ) : balanceSeries.length === 0 ? (
            <EmptyState icon={<ChartBarIcon aria-hidden className="size-8" />} message="本期暂无余额序列" />
          ) : (
            <BalanceAreaChart series={balanceSeries} height={180} />
          )}
        </Panel>
      </div>

      <Panel title={typeof totalTx === 'number' ? `流水 · 共 ${totalTx} 笔` : '流水'}>
        {txQuery.isLoading ? (
          <div className="flex flex-col gap-1">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-8" />
            ))}
          </div>
          ) : txQuery.isError ? (
            <ErrorState message="账户流水加载失败" onRetry={() => void txQuery.refetch()} />
          ) : rows.length === 0 ? (
          <EmptyState icon={<BanknotesIcon aria-hidden className="size-9 text-[var(--text-tertiary)]" />} message="本期该账户暂无交易" />
        ) : (
          <>
            <div ref={listRef} className="flex flex-col">
              {rows.map((row) => {
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
            {canLoadMore && (
              <div className="flex justify-center pt-3">
                <Button variant="secondary" size="md" disabled={txQuery.isFetchingNextPage} onClick={() => void txQuery.fetchNextPage()}>
                  {txQuery.isFetchingNextPage ? '加载中…' : '加载更多'}
                </Button>
              </div>
            )}
          </>
        )}
      </Panel>

      {/* 危险区：整块用 danger 描边圈起来，跟上面的常规面板区分开 */}
      <section className="rounded-lg border border-[var(--danger)] bg-[var(--surface-1)] p-4 shadow-[var(--shadow-card)]">
        <h2 className="mb-3 text-[11px] font-medium tracking-wide text-[var(--danger)] uppercase">删除账户</h2>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-[var(--text-secondary)]">
            这会同时删除该账户下的 <span className="font-mono tabular-nums">{allTimeCount.data ?? '…'}</span> 笔交易，不可撤销。
          </p>
          <div className="max-w-sm">
            <Field
              label="输入账户名确认"
              hint={attrs?.name ? `需要一字不差地输入「${attrs.name}」` : undefined}
              error={confirmName && confirmName !== attrs?.name ? '与账户名不一致' : undefined}
            >
              <Input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={attrs?.name ?? '账户全名'} />
            </Field>
          </div>
          <Button
            variant="danger"
            size="md"
            className="self-start"
            disabled={confirmName !== attrs?.name || deleteAccountMutation.isPending}
            onClick={() => void confirmDeleteAccount()}
          >
            {deleteAccountMutation.isPending ? '删除中…' : '删除账户'}
          </Button>
        </div>
      </section>

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

function BackLink() {
  return (
    <Link
      to="/accounts"
      className="inline-flex w-fit items-center gap-1 text-[12.5px] text-[var(--brand-text)] "

    >
      <ArrowLeftIcon aria-hidden className="size-3.5" />
      返回账户
    </Link>
  )
}
