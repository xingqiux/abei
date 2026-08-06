import { useMemo, useState } from 'react'
import { PlusIcon } from '@heroicons/react/20/solid'
import { useSearch, useNavigate } from '@tanstack/react-router'
import { useCreateBudget, useCreateBudgetWithLimit, useCurrencies } from '../../api/queries'
import { useBudgetsData } from './useBudgetsData'
import { EmptyState } from '../../components/abaku/EmptyState'
import { ErrorState } from '../../components/abaku/ErrorState'
import { Skeleton } from '../../components/abaku/Skeleton'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { Field, Input, Select } from '../../components/ui/Field'
import { Tabs } from '../../components/ui/Tabs'
import { useStaggerIn } from '../../motion/useStaggerIn'
import { usePageRange } from '../../store/dateRangeStore'
import { BudgetRow } from './BudgetRow'
import { BUDGETS_TAB_CONFIG, type BudgetsTab } from './budgetsHelpers'
import { showToast } from '../../store/toastStore'
import { FireflyApiError } from '../../api/client'
import { Modal } from '../../components/abaku/Modal'
import { isPositiveDecimal, normalizeDecimalString } from '../../lib/decimal'
import { SubscriptionsTab } from './SubscriptionsTab'

function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-1 p-2" role="status" aria-label="加载中">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-8" />
      ))}
    </div>
  )
}

function BudgetsTabContent() {
  const range = usePageRange('budgets')
  const { budgetsQuery, limitsByBudget, limitStateByBudget } = useBudgetsData(range)
  const budgets = budgetsQuery.data?.data ?? []
  const listRef = useStaggerIn<HTMLDivElement>([budgetsQuery.isSuccess])
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [limitAmount, setLimitAmount] = useState('')
  const [currencyCode, setCurrencyCode] = useState('')
  const createBudget = useCreateBudget()
  const createWithLimit = useCreateBudgetWithLimit()
  const currenciesQuery = useCurrencies()

  const openCreate = () => {
    const currencies = currenciesQuery.data?.data ?? []
    setCurrencyCode(
      currencies.find((currency) => currency.attributes.default && currency.attributes.enabled !== false)?.attributes.code
      ?? currencies.find((currency) => currency.attributes.enabled !== false)?.attributes.code
      ?? '',
    )
    setCreateOpen(true)
  }

  async function handleCreate() {
    const n = name.trim()
    if (!n) {
      showToast({ message: '请输入预算名称', kind: 'error' })
      return
    }
    try {
      let hasValidLimit = false
      try {
        hasValidLimit = limitAmount.trim() !== '' && isPositiveDecimal(limitAmount)
      } catch {
        hasValidLimit = false
      }
      if (limitAmount.trim() && !hasValidLimit) {
        showToast({ message: '限额必须是大于 0 的有效金额', kind: 'error' })
        return
      }
      if (hasValidLimit) {
        if (!currencyCode) {
          showToast({ message: '请选择限额币种', kind: 'error' })
          return
        }
        await createWithLimit.mutateAsync({
          name: n,
          active: true,
          limit: { start: range.start, end: range.end, amount: normalizeDecimalString(limitAmount), currency_code: currencyCode },
        })
      } else {
        await createBudget.mutateAsync({ name: n, active: true })
      }
      setCreateOpen(false)
      setName('')
      setLimitAmount('')
      showToast({ message: '预算已创建', kind: 'success' })
    } catch (err) {
      const message = err instanceof FireflyApiError ? err.message : '创建失败，请重试'
      showToast({ message, kind: 'error', duration: 6000 })
    }
  }

  return (
    <>
      <div className="mb-2 flex justify-end px-1">
        <Button variant="primary" size="sm" onClick={openCreate}>
          <PlusIcon aria-hidden className="size-4" />
          新建预算
        </Button>
      </div>
      {budgetsQuery.isLoading ? (
        <ListSkeleton />
      ) : budgetsQuery.isError ? (
        <ErrorState
          message={budgetsQuery.error instanceof Error ? `预算加载失败：${budgetsQuery.error.message}` : '预算加载失败，请检查 API 或刷新重试'}
          onRetry={() => void budgetsQuery.refetch()}
        />
      ) : budgets.length === 0 ? (
        <EmptyState message="还没有预算" actionLabel="新建预算" onAction={openCreate} />
      ) : (
        <div ref={listRef} className="flex flex-col">
          {budgets.map((b) => (
            <BudgetRow key={b.id} budget={b} limits={limitsByBudget.get(b.id) ?? []} range={range} limitsLoading={limitStateByBudget.get(b.id)?.isLoading} limitsError={limitStateByBudget.get(b.id)?.isError} onRetryLimits={() => void limitStateByBudget.get(b.id)?.refetch?.()} />
          ))}
        </div>
      )}

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="新建预算"
        width={400}
        footer={
          <>
            <Button variant="secondary" size="md" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              size="md"
              disabled={createBudget.isPending || createWithLimit.isPending || !name.trim()}
              onClick={() => void handleCreate()}
            >
              {createBudget.isPending || createWithLimit.isPending ? '创建中…' : '创建'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="名称">
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="限额币种">
            <Select className="font-mono tabular-nums" value={currencyCode} onChange={(event) => setCurrencyCode(event.target.value)}>
              <option value="">选择币种…</option>
              {(currenciesQuery.data?.data ?? [])
                .filter((currency) => currency.attributes.enabled !== false)
                .map((currency) => (
                  <option key={currency.id} value={currency.attributes.code}>
                    {currency.attributes.code} · {currency.attributes.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="当期限额" hint={`可选。作用范围 ${range.start} → ${range.end}`}>
            <Input
              className="text-right font-mono tabular-nums"
              value={limitAmount}
              onChange={(e) => setLimitAmount(e.target.value.replace(/[^0-9.]/g, ''))}
              placeholder="如 2000"
            />
          </Field>
        </div>
      </Modal>
    </>
  )
}

export function BudgetsPage() {
  const search = useSearch({ from: '/budgets' })
  const navigate = useNavigate({ from: '/budgets' })
  const [activeTab, setActiveTab] = useState<BudgetsTab>(search.tab === 'subscriptions' ? 'subscriptions' : 'budgets')

  const content = useMemo(() => {
    if (activeTab === 'budgets') return <BudgetsTabContent />
    return <SubscriptionsTab />
  }, [activeTab])

  function changeTab(tab: BudgetsTab) {
    setActiveTab(tab)
    void navigate({ search: { tab: tab === 'budgets' ? undefined : tab }, replace: true })
  }

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-lg font-semibold text-[var(--text-primary)]">预算</h1>

      <Tabs
        aria-label="预算视图"
        tabs={BUDGETS_TAB_CONFIG.map((tab) => ({ value: tab.key, label: tab.label }))}
        value={activeTab}
        onChange={changeTab}
      />

      <Card padded={false} className="p-2">{content}</Card>
    </div>
  )
}
