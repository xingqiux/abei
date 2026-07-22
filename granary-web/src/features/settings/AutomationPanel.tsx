import { useEffect, useState } from 'react'
import { FlaskConical, Play } from 'lucide-react'
import {
  useRecurrences,
  useRuleGroups,
  useRules,
  useTestRule,
  useTestRuleGroup,
  useTriggerRecurrence,
  useTriggerRule,
  useTriggerRuleGroup,
} from '../../api/queries'
import { useDateRangeStore } from '../../store/dateRangeStore'
import { FireflyApiError } from '../../api/client'
import type { Recurrence } from '../../api/schemas'
import { showToast } from '../../store/toastStore'
import { formatDateTime, toDateInputValue } from '../../lib/format'

type AutomationKind = 'rule' | 'group'
type ExecutionResult = { count: number; completedAt: string; range: { start: string; end: string } }
type RecurrenceResult = { ids: string[]; completedAt: string }

export function AutomationPanel() {
  const rules = useRules()
  const groups = useRuleGroups()
  const recurrences = useRecurrences()
  const range = useDateRangeStore()
  const testRuleMutation = useTestRule()
  const testGroupMutation = useTestRuleGroup()
  const triggerRuleMutation = useTriggerRule()
  const triggerGroupMutation = useTriggerRuleGroup()
  const triggerRecurrenceMutation = useTriggerRecurrence()
  const [previews, setPreviews] = useState<Record<string, number>>({})
  const [executions, setExecutions] = useState<Record<string, ExecutionResult>>({})
  const [recurrenceResults, setRecurrenceResults] = useState<Record<string, RecurrenceResult>>({})

  useEffect(() => {
    setPreviews({})
    setExecutions({})
  }, [range.start, range.end])

  async function test(kind: AutomationKind, id: string) {
    try {
      const result = kind === 'rule'
        ? await testRuleMutation.mutateAsync({ id, range })
        : await testGroupMutation.mutateAsync({ id, range })
      const count = result.meta?.pagination?.total ?? result.data.length
      setPreviews((current) => ({ ...current, [`${kind}-${id}`]: count }))
      showToast({ kind: 'success', message: `测试完成：匹配 ${count} 个交易组` })
    } catch (error) {
      showToast({ kind: 'error', message: error instanceof FireflyApiError ? error.message : '规则测试失败', duration: 6000 })
    }
  }

  async function trigger(kind: AutomationKind, id: string, title: string) {
    const count = previews[`${kind}-${id}`]
    if (count === undefined) {
      showToast({ kind: 'error', message: '请先测试匹配范围' })
      return
    }
    if (!window.confirm(`执行“${title}”，处理 ${range.start} 至 ${range.end} 匹配的 ${count} 个交易组？`)) return
    try {
      if (kind === 'rule') await triggerRuleMutation.mutateAsync({ id, range })
      else await triggerGroupMutation.mutateAsync({ id, range })
      setExecutions((current) => ({
        ...current,
        [`${kind}-${id}`]: { count, completedAt: new Date().toISOString(), range: { ...range } },
      }))
      showToast({ kind: 'success', message: `规则已执行，处理 ${count} 个匹配交易组` })
      setPreviews((current) => { const next = { ...current }; delete next[`${kind}-${id}`]; return next })
    } catch (error) {
      showToast({ kind: 'error', message: error instanceof FireflyApiError ? error.message : '规则执行失败', duration: 6000 })
    }
  }

  async function triggerRecurrence(id: string, title: string) {
    const date = toDateInputValue(new Date())
    if (!window.confirm(`立即触发定期交易“${title}”（${date}）？`)) return
    try {
      const result = await triggerRecurrenceMutation.mutateAsync({ id, date })
      setRecurrenceResults((current) => ({
        ...current,
        [id]: { ids: result.data.map((group) => group.id), completedAt: new Date().toISOString() },
      }))
      showToast({ kind: 'success', message: `已触发，生成 ${result.data.length} 个交易组` })
    } catch (error) {
      showToast({ kind: 'error', message: error instanceof FireflyApiError ? error.message : '定期交易触发失败', duration: 6000 })
    }
  }

  const pending = testRuleMutation.isPending || testGroupMutation.isPending || triggerRuleMutation.isPending || triggerGroupMutation.isPending

  return (
    <div className="flex flex-col gap-4">
      <AutomationGroup label="规则" loading={rules.isLoading} error={rules.isError} onRetry={() => void rules.refetch()}>
        {(rules.data?.data ?? []).map((item) => <RuleRow key={item.id} title={item.attributes.title} active={item.attributes.active} count={previews[`rule-${item.id}`]} execution={executions[`rule-${item.id}`]} pending={pending} onTest={() => void test('rule', item.id)} onTrigger={() => void trigger('rule', item.id, item.attributes.title)} />)}
      </AutomationGroup>
      <AutomationGroup label="规则组" loading={groups.isLoading} error={groups.isError} onRetry={() => void groups.refetch()}>
        {(groups.data?.data ?? []).map((item) => <RuleRow key={item.id} title={item.attributes.title} active={item.attributes.active} count={previews[`group-${item.id}`]} execution={executions[`group-${item.id}`]} pending={pending} onTest={() => void test('group', item.id)} onTrigger={() => void trigger('group', item.id, item.attributes.title)} />)}
      </AutomationGroup>
      <AutomationGroup label="定期交易" loading={recurrences.isLoading} error={recurrences.isError} onRetry={() => void recurrences.refetch()}>
        {(recurrences.data?.data ?? []).map((item) => <RecurrenceRow key={item.id} recurrence={item} result={recurrenceResults[item.id]} pending={triggerRecurrenceMutation.isPending} onTrigger={() => void triggerRecurrence(item.id, item.attributes.title)} />)}
      </AutomationGroup>
    </div>
  )
}

function AutomationGroup({ label, loading, error, onRetry, children }: { label: string; loading: boolean; error: boolean; onRetry: () => void; children: React.ReactNode }) {
  return <section><h3 className="mb-1.5 text-[12px]" style={{ color: 'var(--g-ink-2)' }}>{label}</h3>{loading ? <span className="text-[12px]">加载中…</span> : error ? <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--g-danger)' }}><span>加载失败</span><button type="button" onClick={onRetry} style={{ color: 'var(--g-accent)' }}>重试</button></div> : <div className="flex flex-col gap-1">{children}</div>}</section>
}

function RuleRow({ title, active, count, execution, pending, onTest, onTrigger }: { title: string; active?: boolean; count?: number; execution?: ExecutionResult; pending: boolean; onTest: () => void; onTrigger: () => void }) {
  return <div className="flex min-h-8 items-center gap-2 rounded-[4px] px-2" style={{ background: 'var(--g-surface-2)' }}><span className="min-w-0 flex-1 truncate text-[12.5px]" style={{ color: active === false ? 'var(--g-ink-2)' : 'var(--g-ink)' }}>{title}</span>{count !== undefined && <span className="font-num text-[11px]" style={{ color: 'var(--g-ink-2)' }}>匹配 {count}</span>}{execution && <span className="font-num text-[11px]" title={`${execution.range.start} 至 ${execution.range.end}`} style={{ color: 'var(--g-income)' }}>已执行 {execution.count} · {formatDateTime(execution.completedAt)}</span>}<button type="button" title="测试规则" aria-label={`测试 ${title}`} disabled={active === false || pending} onClick={onTest} className="rounded p-1 disabled:opacity-30" style={{ color: 'var(--g-ink-2)' }}><FlaskConical size={13} /></button><button type="button" title="执行规则" aria-label={`执行 ${title}`} disabled={active === false || pending || count === undefined} onClick={onTrigger} className="rounded p-1 disabled:opacity-30" style={{ color: 'var(--g-accent)' }}><Play size={13} /></button></div>
}

function RecurrenceRow({ recurrence, result, pending, onTrigger }: { recurrence: Recurrence; result?: RecurrenceResult; pending: boolean; onTrigger: () => void }) {
  const { attributes } = recurrence
  const nextOccurrence = attributes.repetitions.flatMap((item) => item.occurrences).sort()[0]
  const executionLabel = attributes.latest_date ? formatDateTime(attributes.latest_date) : '尚未执行'
  const nextLabel = nextOccurrence ? formatDateTime(nextOccurrence) : '暂无计划'

  return (
    <div className="rounded-[4px] px-2 py-1.5" style={{ background: 'var(--g-surface-2)' }}>
      <div className="flex min-h-6 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12.5px]" style={{ color: attributes.active === false ? 'var(--g-ink-2)' : 'var(--g-ink)' }}>{attributes.title}</span>
        <button type="button" title="触发定期交易" aria-label={`触发 ${attributes.title}`} disabled={attributes.active === false || pending} onClick={onTrigger} className="rounded p-1 disabled:opacity-30" style={{ color: 'var(--g-accent)' }}><Play size={13} /></button>
      </div>
      <div className="font-num flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]" style={{ color: 'var(--g-ink-2)' }}>
        <span>最近 {executionLabel}</span>
        <span>下次 {nextLabel}</span>
        {result && <span style={{ color: 'var(--g-income)' }}>本次生成 {result.ids.length} 个 · {formatDateTime(result.completedAt)}</span>}
        {result?.ids[0] && <a href={`/transactions?transaction=${encodeURIComponent(result.ids[0])}`} className="font-sans" style={{ color: 'var(--g-accent)' }}>查看生成交易</a>}
      </div>
    </div>
  )
}
