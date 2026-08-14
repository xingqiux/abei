import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import {
  Archive,
  ArrowClockwise,
  ChatCircleDots,
  FloppyDisk,
  GitMerge,
  LinkSimple,
  PaperPlaneTilt,
  Plus,
} from '@phosphor-icons/react'
import {
  archiveAdminFeedbackItem,
  getAdminFeedbackItem,
  getAdminFeedbackSubmission,
  linkAdminFeedbackSubmission,
  listAdminFeedbackItems,
  listAdminFeedbackSubmissions,
  mergeAdminFeedbackItem,
  messageAdminFeedbackSubmission,
  moderateAdminFeedbackSubmission,
  publishAdminFeedbackUpdate,
  restoreAdminFeedbackItem,
  updateAdminFeedbackItem,
  type AdminFeedbackSubmission,
  type FeedbackCandidate,
  type FeedbackDetailResponse,
  type FeedbackItem,
  type FeedbackKind,
  type FeedbackSeverity,
  type FeedbackStatus,
  type FeedbackTarget,
} from '../../api/feedback'
import { AbeiApiError } from '../../api/client'
import { ErrorState } from '../../components/abei/ErrorState'
import { Badge, type BadgeTone } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Card, SectionHeading } from '../../components/ui/Card'
import { CONTROL_COMPACT, Field, Input, Select, Textarea } from '../../components/ui/Field'
import { Tabs } from '../../components/ui/Tabs'
import { formatDateTime } from '../../lib/format'
import { showToast } from '../../store/toastStore'

type AdminTab = 'inbox' | 'items' | 'archive'

const ADMIN_TABS = [
  { value: 'inbox', label: '收件箱' },
  { value: 'items', label: '反馈事项' },
  { value: 'archive', label: '归档' },
] as const

const KIND_OPTIONS: Array<{ value: '' | FeedbackKind; label: string }> = [
  { value: '', label: '全部类型' },
  { value: 'bug', label: '问题' },
  { value: 'experience', label: '体验' },
  { value: 'suggestion', label: '建议' },
]

const TARGET_OPTIONS: Array<{ value: '' | FeedbackTarget; label: string }> = [
  { value: '', label: '全部对象' },
  { value: 'cli', label: 'CLI' },
  { value: 'app', label: 'App' },
  { value: 'web', label: '网页' },
]

const SUBMISSION_STATE_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'pending_confirmation', label: '待用户确认' },
  { value: 'needs_information', label: '待用户补充' },
  { value: 'linked', label: '已归一' },
  { value: 'dismissed', label: '已驳回' },
  { value: 'redacted', label: '已脱敏' },
] as const

const EMPTY_SUBMISSIONS: AdminFeedbackSubmission[] = []
const EMPTY_ITEMS: FeedbackItem[] = []

export function AdminFeedbackPage() {
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<AdminTab>('inbox')
  const [kind, setKind] = useState<'' | FeedbackKind>('')
  const [target, setTarget] = useState<'' | FeedbackTarget>('')
  const [submissionState, setSubmissionState] = useState('')
  const [selectedSubmissionId, setSelectedSubmissionId] = useState<number | null>(null)
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null)

  // 页面不再自己查 owner：整个后台被 OwnerGate 挡在门口，能渲染到这里就已经是 owner。
  const submissionsQuery = useQuery({
    queryKey: ['admin-feedback-submissions', submissionState, kind, target],
    queryFn: () => listAdminFeedbackSubmissions({
      state: submissionState || undefined,
      kind: kind || undefined,
      target: target || undefined,
      limit: 100,
    }),
  })
  const itemsQuery = useQuery({
    queryKey: ['admin-feedback-items', false, kind, target],
    queryFn: () => listAdminFeedbackItems({
      archived: false,
      kind: kind || undefined,
      target: target || undefined,
      limit: 100,
    }),
  })
  const archiveQuery = useQuery({
    queryKey: ['admin-feedback-items', true, kind, target],
    queryFn: () => listAdminFeedbackItems({
      archived: true,
      kind: kind || undefined,
      target: target || undefined,
      limit: 100,
    }),
  })

  const submissions = submissionsQuery.data?.data ?? EMPTY_SUBMISSIONS
  const items = itemsQuery.data?.data ?? EMPTY_ITEMS
  const archivedItems = archiveQuery.data?.data ?? EMPTY_ITEMS

  useEffect(() => {
    if (tab !== 'inbox') return
    if (!submissions.some((submission) => submission.submission_id === selectedSubmissionId)) {
      setSelectedSubmissionId(submissions[0]?.submission_id ?? null)
    }
  }, [selectedSubmissionId, submissions, tab])

  useEffect(() => {
    const visibleItems = tab === 'archive' ? archivedItems : items
    if (tab === 'inbox') return
    if (!visibleItems.some((item) => item.feedback_id === selectedItemId)) {
      setSelectedItemId(visibleItems[0]?.feedback_id ?? null)
    }
  }, [archivedItems, items, selectedItemId, tab])

  const tabs = ADMIN_TABS.map((entry) => ({
    ...entry,
    count: entry.value === 'inbox'
      ? submissions.length
      : entry.value === 'items'
        ? items.length
        : archivedItems.length,
  }))

  async function refresh() {
    if (tab === 'inbox') await submissionsQuery.refetch()
    else if (tab === 'items') await itemsQuery.refetch()
    else await archiveQuery.refetch()
  }

  const activeQuery = tab === 'inbox' ? submissionsQuery : tab === 'items' ? itemsQuery : archiveQuery

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-[var(--text-primary)]">反馈管理</h1>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">归一、处理并向用户同步进展</p>
        </div>
        <Button variant="secondary" size="md" disabled={activeQuery.isFetching} onClick={() => void refresh()}>
          <ArrowClockwise aria-hidden className={`size-4 ${activeQuery.isFetching ? 'animate-spin' : ''}`} />
          刷新
        </Button>
      </header>

      <Tabs tabs={tabs} value={tab} onChange={setTab} aria-label="反馈管理视图" />

      <div className="flex flex-wrap items-center gap-2">
        {tab === 'inbox' && (
          <select
            aria-label="Submission 状态"
            className={CONTROL_COMPACT}
            value={submissionState}
            onChange={(event) => setSubmissionState(event.target.value)}
          >
            {SUBMISSION_STATE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        )}
        <select aria-label="反馈类型" className={CONTROL_COMPACT} value={kind} onChange={(event) => setKind(event.target.value as '' | FeedbackKind)}>
          {KIND_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <select aria-label="反馈对象" className={CONTROL_COMPACT} value={target} onChange={(event) => setTarget(event.target.value as '' | FeedbackTarget)}>
          {TARGET_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </div>

      {tab === 'inbox' ? (
        <SubmissionWorkspace
          query={submissionsQuery}
          submissions={submissions}
          selectedId={selectedSubmissionId}
          onSelect={setSelectedSubmissionId}
        />
      ) : (
        <ItemWorkspace
          query={tab === 'archive' ? archiveQuery : itemsQuery}
          items={tab === 'archive' ? archivedItems : items}
          archived={tab === 'archive'}
          selectedId={selectedItemId}
          onSelect={setSelectedItemId}
          onMoved={() => setSelectedItemId(null)}
          queryClient={queryClient}
        />
      )}
    </div>
  )
}

function PageStatus({ message }: { message: string }) {
  return (
    <Card className="mx-auto w-full max-w-3xl">
      <p role="status" className="py-16 text-center text-sm text-[var(--text-secondary)]">{message}</p>
    </Card>
  )
}

function SubmissionWorkspace({
  query,
  submissions,
  selectedId,
  onSelect,
}: {
  query: ReturnType<typeof useQuery<Awaited<ReturnType<typeof listAdminFeedbackSubmissions>>>>
  submissions: AdminFeedbackSubmission[]
  selectedId: number | null
  onSelect: (id: number) => void
}) {
  return (
    <div className="grid min-h-[650px] items-stretch gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
      <Card padded={false} className="min-w-0 overflow-hidden">
        <div className="border-b border-[var(--border-subtle)] px-4 py-3">
          <SectionHeading title="Submission" description="每次用户提交均独立保留" />
        </div>
        {query.isLoading ? (
          <p role="status" className="px-4 py-12 text-center text-sm text-[var(--text-secondary)]">正在读取收件箱…</p>
        ) : query.isError ? (
          <ErrorState message="反馈收件箱加载失败" error={query.error} onRetry={() => void query.refetch()} />
        ) : submissions.length === 0 ? (
          <p className="px-4 py-12 text-center text-sm text-[var(--text-secondary)]">没有符合条件的 Submission</p>
        ) : (
          <ul role="list" className="divide-y divide-[var(--border-subtle)]">
            {submissions.map((submission) => {
              const active = submission.submission_id === selectedId
              return (
                <li key={submission.submission_id}>
                  <button
                    type="button"
                    aria-current={active ? 'page' : undefined}
                    onClick={() => onSelect(submission.submission_id)}
                    className={`w-full px-4 py-3 text-left transition-colors ${active ? 'bg-[var(--surface-selected)]' : 'hover:bg-[var(--surface-hover)]'}`}
                  >
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={submissionTone(submission.state)}>{submissionStateLabel(submission.state)}</Badge>
                      <Badge tone={kindTone(submission.kind)}>{kindLabel(submission.kind)}</Badge>
                      <Badge>{targetLabel(submission.target)}</Badge>
                    </span>
                    <span className="mt-2 line-clamp-2 block text-sm leading-5 text-[var(--text-primary)]">{submission.message}</span>
                    <span className="mt-2 flex items-center justify-between gap-2 text-[11px] text-[var(--text-tertiary)]">
                      <span>Submission #{submission.submission_id}</span>
                      <time dateTime={submission.created_at}>{formatDateTime(submission.created_at)}</time>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      {selectedId === null ? (
        <PanelPlaceholder icon={<ChatCircleDots className="size-8" />} message="选择一条 Submission 查看详情" />
      ) : (
        <SubmissionDetailPanel key={selectedId} submissionId={selectedId} />
      )}
    </div>
  )
}

function SubmissionDetailPanel({ submissionId }: { submissionId: number }) {
  const queryClient = useQueryClient()
  const [reply, setReply] = useState('')
  const [reason, setReason] = useState('')
  const [itemId, setItemId] = useState('')
  const [newTitle, setNewTitle] = useState('')
  const [error, setError] = useState<string | null>(null)
  const detailQuery = useQuery({
    queryKey: ['admin-feedback-submission', submissionId],
    queryFn: () => getAdminFeedbackSubmission(submissionId),
  })
  const messageMutation = useMutation({
    mutationFn: (message: string) => messageAdminFeedbackSubmission(submissionId, message),
  })
  const linkMutation = useMutation({
    mutationFn: (input: { item_id?: number; new?: boolean; title?: string; reason: string }) => linkAdminFeedbackSubmission(submissionId, input),
  })
  const moderateMutation = useMutation({
    mutationFn: (state: 'dismissed' | 'redacted') => moderateAdminFeedbackSubmission(submissionId, { state, reason: reason.trim() }),
  })
  const reasonBytes = auditReasonBytes(reason)
  const validReason = reason.trim().length > 0 && reasonBytes <= 3 * 1024

  async function refreshAfterMutation() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['admin-feedback-submission', submissionId] }),
      queryClient.invalidateQueries({ queryKey: ['admin-feedback-submissions'] }),
      queryClient.invalidateQueries({ queryKey: ['admin-feedback-items'] }),
    ])
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!reply.trim()) return
    setError(null)
    try {
      await messageMutation.mutateAsync(reply.trim())
      setReply('')
      await refreshAfterMutation()
      showToast({ kind: 'success', message: '追问已发送' })
    } catch (caught) {
      setError(errorMessage(caught, '追问发送失败'))
    }
  }

  async function link(input: { item_id?: number; new?: boolean; title?: string }) {
    if (!validReason) return
    setError(null)
    try {
      await linkMutation.mutateAsync({ ...input, reason: reason.trim() })
      setItemId('')
      setNewTitle('')
      setReason('')
      await refreshAfterMutation()
      showToast({ kind: 'success', message: 'Submission 已归一' })
    } catch (caught) {
      setError(errorMessage(caught, '归一失败'))
    }
  }

  async function moderate(state: 'dismissed' | 'redacted') {
    if (!validReason) return
    if (state === 'redacted' && !window.confirm('脱敏会永久清除原始描述、上下文和匹配候选，确定继续吗？')) return
    setError(null)
    try {
      await moderateMutation.mutateAsync(state)
      setReason('')
      await refreshAfterMutation()
      showToast({ kind: 'success', message: state === 'redacted' ? 'Submission 已脱敏' : 'Submission 已驳回' })
    } catch (caught) {
      setError(errorMessage(caught, '处理失败'))
    }
  }

  if (detailQuery.isLoading) return <PageStatus message="正在读取 Submission…" />
  if (detailQuery.isError) {
    return <Card><ErrorState message="Submission 详情加载失败" error={detailQuery.error} onRetry={() => void detailQuery.refetch()} /></Card>
  }
  if (!detailQuery.data) return null

  const submission = detailQuery.data.data
  const active = !['dismissed', 'redacted'].includes(submission.state)
  const busy = linkMutation.isPending || moderateMutation.isPending

  return (
    <Card padded={false} className="min-w-0 overflow-hidden">
      <div className="border-b border-[var(--border-subtle)] px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold text-[var(--text-primary)]">Submission #{submission.submission_id}</h2>
              <Badge tone={submissionTone(submission.state)}>{submissionStateLabel(submission.state)}</Badge>
            </div>
            <p className="mt-1 text-xs text-[var(--text-secondary)]">用户 #{submission.user_id ?? '未知'} · {submission.submitted_via} · {formatDateTime(submission.created_at)}</p>
          </div>
          {submission.feedback_id && (
            <span className="text-xs font-medium text-[var(--brand-text)]">Feedback #{submission.feedback_id} · {submission.item_status ? statusLabel(submission.item_status as FeedbackStatus) : ''}</span>
          )}
        </div>
      </div>

      <div className="grid min-w-0 gap-0 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 px-4 py-4 xl:border-r xl:border-[var(--border-subtle)]">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={kindTone(submission.kind)}>{kindLabel(submission.kind)}</Badge>
            <Badge>{targetLabel(submission.target)}</Badge>
            {submission.has_fingerprint && <Badge tone="brand">已采集诊断指纹</Badge>}
          </div>
          <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-[var(--text-primary)]">{submission.message}</p>
          {submission.expected && <DetailText label="预期" value={submission.expected} />}
          {submission.actual && <DetailText label="实际" value={submission.actual} />}

          {submission.candidates.length > 0 && (
            <section className="mt-5 border-t border-[var(--border-subtle)] pt-4">
              <h3 className="text-xs font-semibold text-[var(--text-secondary)]">相似候选</h3>
              <ul role="list" className="mt-2 divide-y divide-[var(--border-subtle)] rounded-md border border-[var(--border-subtle)]">
                {submission.candidates.map((candidate) => (
                  <CandidateRow
                    key={candidate.feedback_id}
                    candidate={candidate}
                    disabled={!active || !validReason || busy}
                    onLink={() => void link({ item_id: candidate.feedback_id })}
                  />
                ))}
              </ul>
            </section>
          )}

          <section className="mt-5 border-t border-[var(--border-subtle)] pt-4">
            <h3 className="text-xs font-semibold text-[var(--text-secondary)]">私有对话</h3>
            {detailQuery.data.messages.length === 0 ? (
              <p className="mt-2 text-sm text-[var(--text-tertiary)]">还没有对话</p>
            ) : (
              <div className="mt-3 space-y-2">
                {detailQuery.data.messages.map((message) => (
                  <div key={message.id} className={`flex ${message.author_kind === 'admin' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[86%] rounded-md px-3 py-2 text-sm ${message.author_kind === 'admin' ? 'bg-[var(--brand-soft)]' : 'bg-[var(--surface-hover)] ring-1 ring-[var(--border-subtle)]'}`}>
                      <p className="whitespace-pre-wrap text-[var(--text-primary)]">{message.body}</p>
                      <p className="mt-1 text-[10px] text-[var(--text-tertiary)]">{message.author_kind === 'admin' ? '管理员' : '用户'} · {formatDateTime(message.created_at)}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {active && (
              <form className="mt-3 flex items-end gap-2" onSubmit={(event) => void sendMessage(event)}>
                <Field label="向用户追问" srOnlyLabel>
                  <Textarea rows={2} maxLength={4000} className="resize-none" value={reply} onChange={(event) => setReply(event.target.value)} placeholder="向用户追问或说明处理情况" />
                </Field>
                <Button type="submit" variant="secondary" size="md" disabled={messageMutation.isPending || !reply.trim()}>
                  <PaperPlaneTilt aria-hidden className="size-4" />发送
                </Button>
              </form>
            )}
          </section>

          <details className="mt-5 border-t border-[var(--border-subtle)] pt-4">
            <summary className="cursor-pointer text-xs font-semibold text-[var(--text-secondary)]">运行上下文与匹配信息</summary>
            <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
              <Meta label="指纹版本" value={String(submission.fingerprint_version)} />
              <Meta label="匹配算法版本" value={String(submission.match_algorithm_version)} />
              <Meta label="最后出现" value={formatDateTime(submission.last_seen_at)} />
            </dl>
            <pre className="mt-3 max-h-72 overflow-auto rounded-md bg-[var(--surface-0)] p-3 font-mono text-[11px] leading-5 text-[var(--text-secondary)] ring-1 ring-[var(--border-subtle)]">{JSON.stringify(submission.context, null, 2)}</pre>
          </details>
          {detailQuery.data.audit.length > 0 && (
            <AuditTrail events={detailQuery.data.audit} className="mt-5 border-t border-[var(--border-subtle)] pt-4" />
          )}
        </div>

        <aside className="border-t border-[var(--border-subtle)] px-4 py-4 xl:border-t-0">
          <SectionHeading title="归一与处理" description="所有操作都会写入审计记录" />
          <div className="mt-4">
            <Field label="处理理由" hint={`${reasonBytes}/3072 bytes`} error={reasonBytes > 3 * 1024 ? '编码后不能超过 3 KiB' : undefined}>
              <Textarea rows={3} maxLength={4000} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="说明判断依据" />
            </Field>
          </div>

          {active && (
            <>
              <div className="mt-4 flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <Field label="关联现有 Feedback ID">
                    <Input inputMode="numeric" value={itemId} onChange={(event) => setItemId(event.target.value.replace(/\D/g, ''))} placeholder="例如 42" />
                  </Field>
                </div>
                <Button size="md" disabled={!validReason || !positiveInteger(itemId) || busy} onClick={() => void link({ item_id: Number(itemId) })}>
                  <LinkSimple aria-hidden className="size-4" />关联
                </Button>
              </div>

              <div className="mt-4 flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <Field label="新建 Feedback 标题" hint="留空时从原始描述生成">
                    <Input maxLength={160} value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="可选标题" />
                  </Field>
                </div>
                <Button size="md" variant="primary" disabled={!validReason || busy} onClick={() => void link({ new: true, title: newTitle.trim() || undefined })}>
                  <Plus aria-hidden className="size-4" />新建
                </Button>
              </div>

              <div className="mt-5 grid grid-cols-2 gap-2 border-t border-[var(--border-subtle)] pt-4">
                <Button variant="ghost-danger" disabled={!validReason || busy} onClick={() => void moderate('dismissed')}>驳回</Button>
                <Button variant="ghost-danger" disabled={!validReason || busy} onClick={() => void moderate('redacted')}>脱敏</Button>
              </div>
            </>
          )}
          {error && <p role="alert" className="mt-3 text-sm text-[var(--danger)]">{error}</p>}
        </aside>
      </div>
    </Card>
  )
}

function CandidateRow({ candidate, disabled, onLink }: { candidate: FeedbackCandidate; disabled: boolean; onLink: () => void }) {
  return (
    <li className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-[var(--text-primary)]">#{candidate.feedback_id} {candidate.title}</p>
        <p className="mt-1 text-xs text-[var(--text-secondary)]">{candidate.affected_users} 人 · {candidate.occurrences} 次 · 相似度 {Math.round(candidate.match.score * 100)}%</p>
      </div>
      <Button size="xs" disabled={disabled} onClick={onLink}>关联</Button>
    </li>
  )
}

function ItemWorkspace({
  query,
  items,
  archived,
  selectedId,
  onSelect,
  onMoved,
  queryClient,
}: {
  query: ReturnType<typeof useQuery<Awaited<ReturnType<typeof listAdminFeedbackItems>>>>
  items: FeedbackItem[]
  archived: boolean
  selectedId: number | null
  onSelect: (id: number) => void
  onMoved: () => void
  queryClient: QueryClient
}) {
  return (
    <div className="grid min-h-[650px] items-stretch gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
      <Card padded={false} className="min-w-0 overflow-hidden">
        <div className="border-b border-[var(--border-subtle)] px-4 py-3">
          <SectionHeading title={archived ? '已归档事项' : 'Feedback Item'} description={archived ? '可恢复非合并产生的归档' : '相似提交归一后的处理对象'} />
        </div>
        {query.isLoading ? (
          <p role="status" className="px-4 py-12 text-center text-sm text-[var(--text-secondary)]">正在读取反馈事项…</p>
        ) : query.isError ? (
          <ErrorState message="反馈事项加载失败" error={query.error} onRetry={() => void query.refetch()} />
        ) : items.length === 0 ? (
          <p className="px-4 py-12 text-center text-sm text-[var(--text-secondary)]">没有符合条件的反馈事项</p>
        ) : (
          <ul role="list" className="divide-y divide-[var(--border-subtle)]">
            {items.map((item) => {
              const active = item.feedback_id === selectedId
              return (
                <li key={item.feedback_id}>
                  <button type="button" aria-current={active ? 'page' : undefined} onClick={() => onSelect(item.feedback_id)} className={`w-full px-4 py-3 text-left transition-colors ${active ? 'bg-[var(--surface-selected)]' : 'hover:bg-[var(--surface-hover)]'}`}>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={statusTone(item.status)}>{statusLabel(item.status)}</Badge>
                      {item.severity && <Badge tone={severityTone(item.severity)}>{severityLabel(item.severity)}</Badge>}
                      <Badge>{targetLabel(item.target)}</Badge>
                    </span>
                    <span className="mt-2 line-clamp-2 block text-sm font-semibold leading-5 text-[var(--text-primary)]">{item.title}</span>
                    <span className="mt-2 flex items-center justify-between gap-2 text-[11px] text-[var(--text-tertiary)]">
                      <span>#{item.feedback_id} · {item.affected_users} 人 / {item.occurrences} 次</span>
                      <time dateTime={item.updated_at}>{formatDateTime(item.updated_at)}</time>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      {selectedId === null ? (
        <PanelPlaceholder icon={<Archive className="size-8" />} message="选择一个反馈事项查看详情" />
      ) : (
        <ItemDetailPanel key={selectedId} feedbackId={selectedId} archived={archived} onMoved={onMoved} queryClient={queryClient} />
      )}
    </div>
  )
}

function ItemDetailPanel({ feedbackId, archived, onMoved, queryClient }: { feedbackId: number; archived: boolean; onMoved: () => void; queryClient: QueryClient }) {
  const detailQuery = useQuery({
    queryKey: ['admin-feedback-item', feedbackId],
    queryFn: () => getAdminFeedbackItem(feedbackId),
  })
  if (detailQuery.isLoading) return <PageStatus message="正在读取 Feedback Item…" />
  if (detailQuery.isError) return <Card><ErrorState message="反馈事项详情加载失败" error={detailQuery.error} onRetry={() => void detailQuery.refetch()} /></Card>
  if (!detailQuery.data) return null
  return (
    <ItemEditor
      key={`${feedbackId}:${detailQuery.data.data.updated_at}`}
      detail={detailQuery.data}
      archived={archived}
      onMoved={onMoved}
      queryClient={queryClient}
    />
  )
}

function ItemEditor({ detail, archived, onMoved, queryClient }: { detail: FeedbackDetailResponse; archived: boolean; onMoved: () => void; queryClient: QueryClient }) {
  const item = detail.data
  const [title, setTitle] = useState(item.title)
  const [kind, setKind] = useState<FeedbackKind>(item.kind)
  const [target, setTarget] = useState<FeedbackTarget>(item.target)
  const [status, setStatus] = useState<FeedbackStatus>(item.status)
  const [severity, setSeverity] = useState<'' | FeedbackSeverity>(item.severity ?? '')
  const [summary, setSummary] = useState(item.public_summary)
  const [closeReason, setCloseReason] = useState(item.close_reason ?? '')
  const [statusUpdate, setStatusUpdate] = useState('')
  const [publicUpdate, setPublicUpdate] = useState('')
  const [mergeTarget, setMergeTarget] = useState('')
  const [actionReason, setActionReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const updateRequired = status !== item.status && ['completed', 'closed'].includes(status)
  const actionReasonBytes = auditReasonBytes(actionReason)
  const validActionReason = actionReason.trim().length > 0 && actionReasonBytes <= 3 * 1024

  async function refreshAll() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['admin-feedback-item'] }),
      queryClient.invalidateQueries({ queryKey: ['admin-feedback-items'] }),
      queryClient.invalidateQueries({ queryKey: ['admin-feedback-submissions'] }),
    ])
  }

  const saveMutation = useMutation({
    mutationFn: () => updateAdminFeedbackItem(item.feedback_id, {
      title: title.trim(),
      kind,
      target,
      status,
      severity: kind === 'bug' ? severity || null : null,
      public_summary: summary.trim(),
      close_reason: closeReason.trim() || null,
      update: statusUpdate.trim() || null,
    }),
  })
  const publishMutation = useMutation({ mutationFn: () => publishAdminFeedbackUpdate(item.feedback_id, publicUpdate.trim()) })
  const mergeMutation = useMutation({ mutationFn: () => mergeAdminFeedbackItem(item.feedback_id, Number(mergeTarget), actionReason.trim()) })
  const archiveMutation = useMutation({
    mutationFn: () => archived
      ? restoreAdminFeedbackItem(item.feedback_id, actionReason.trim())
      : archiveAdminFeedbackItem(item.feedback_id, actionReason.trim()),
  })

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!title.trim() || (updateRequired && !statusUpdate.trim()) || (status === 'closed' && !closeReason.trim())) return
    setError(null)
    try {
      await saveMutation.mutateAsync()
      setStatusUpdate('')
      await refreshAll()
      showToast({ kind: 'success', message: '反馈事项已保存' })
    } catch (caught) {
      setError(errorMessage(caught, '保存失败'))
    }
  }

  async function publish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!publicUpdate.trim()) return
    setError(null)
    try {
      await publishMutation.mutateAsync()
      setPublicUpdate('')
      await refreshAll()
      showToast({ kind: 'success', message: '公开进展已发布' })
    } catch (caught) {
      setError(errorMessage(caught, '发布失败'))
    }
  }

  async function merge() {
    if (!positiveInteger(mergeTarget) || !validActionReason) return
    if (!window.confirm(`将 Feedback #${item.feedback_id} 的全部 Submission 合并到 #${mergeTarget}，确定继续吗？`)) return
    setError(null)
    try {
      await mergeMutation.mutateAsync()
      await refreshAll()
      onMoved()
      showToast({ kind: 'success', message: '反馈事项已合并' })
    } catch (caught) {
      setError(errorMessage(caught, '合并失败'))
    }
  }

  async function moveArchive() {
    if (!validActionReason) return
    setError(null)
    try {
      await archiveMutation.mutateAsync()
      await refreshAll()
      onMoved()
      showToast({ kind: 'success', message: archived ? '反馈事项已恢复' : '反馈事项已归档' })
    } catch (caught) {
      setError(errorMessage(caught, archived ? '恢复失败' : '归档失败'))
    }
  }

  return (
    <Card padded={false} className="min-w-0 overflow-hidden">
      <div className="border-b border-[var(--border-subtle)] px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-base font-semibold text-[var(--text-primary)]">Feedback #{item.feedback_id}</h2>
              <Badge tone={statusTone(item.status)}>{statusLabel(item.status)}</Badge>
              {item.severity && <Badge tone={severityTone(item.severity)}>{severityLabel(item.severity)}</Badge>}
            </div>
            <p className="mt-1 text-xs text-[var(--text-secondary)]">{item.affected_users} 位用户 · {item.occurrences} 次提交 · 更新于 {formatDateTime(item.updated_at)}</p>
          </div>
        </div>
      </div>

      <div className="grid min-w-0 gap-0 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 px-4 py-4 xl:border-r xl:border-[var(--border-subtle)]">
          {!archived && (
            <form className="grid gap-4" onSubmit={(event) => void save(event)}>
              <Field label="标题" hint={`${title.length}/160`}>
                <Input required maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
                <Field label="类型">
                  <Select value={kind} onChange={(event) => {
                    const next = event.target.value as FeedbackKind
                    setKind(next)
                    if (next !== 'bug') setSeverity('')
                  }}>
                    {KIND_OPTIONS.slice(1).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </Select>
                </Field>
                <Field label="对象">
                  <Select value={target} onChange={(event) => setTarget(event.target.value as FeedbackTarget)}>
                    {TARGET_OPTIONS.slice(1).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </Select>
                </Field>
                <Field label="状态">
                  <Select value={status} onChange={(event) => setStatus(event.target.value as FeedbackStatus)}>
                    {(['open', 'reviewing', 'planned', 'in_progress', 'completed', 'closed'] as const).map((value) => <option key={value} value={value}>{statusLabel(value)}</option>)}
                  </Select>
                </Field>
                <Field label="严重程度">
                  <Select disabled={kind !== 'bug'} value={severity} onChange={(event) => setSeverity(event.target.value as '' | FeedbackSeverity)}>
                    <option value="">未设置</option>
                    {(['critical', 'high', 'normal', 'low'] as const).map((value) => <option key={value} value={value}>{severityLabel(value)}</option>)}
                  </Select>
                </Field>
              </div>
              <Field label="公开摘要" hint={`${summary.length}/4000，所有关联用户可见`}>
                <Textarea rows={4} maxLength={4000} value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="当前判断或处理结论" />
              </Field>
              <Field label="关闭原因" hint="状态为已关闭时必填">
                <Textarea rows={2} maxLength={4000} value={closeReason} onChange={(event) => setCloseReason(event.target.value)} />
              </Field>
              <Field label="随状态发布的进展" hint={updateRequired ? '改为已完成或已关闭时必填' : '可选，填写后会公开给用户'} error={updateRequired && !statusUpdate.trim() ? '当前状态变化必须同步一条公开进展' : undefined}>
                <Textarea rows={3} maxLength={4000} value={statusUpdate} onChange={(event) => setStatusUpdate(event.target.value)} />
              </Field>
              <div className="flex justify-end">
                <Button type="submit" variant="primary" size="md" disabled={saveMutation.isPending || !title.trim() || (updateRequired && !statusUpdate.trim()) || (status === 'closed' && !closeReason.trim())}>
                  <FloppyDisk aria-hidden className="size-4" />{saveMutation.isPending ? '保存中…' : '保存'}
                </Button>
              </div>
            </form>
          )}

          <section className={`${archived ? '' : 'mt-6 border-t border-[var(--border-subtle)] pt-5'}`}>
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">公开处理进展</h3>
            {detail.updates.length === 0 ? (
              <p className="mt-2 text-sm text-[var(--text-tertiary)]">还没有公开进展</p>
            ) : (
              <ol className="mt-3 border-l-2 border-[var(--border-subtle)] pl-3">
                {detail.updates.map((update) => (
                  <li key={update.id} className="mb-3 last:mb-0">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-tertiary)]"><Badge tone={statusTone(update.status as FeedbackStatus)}>{statusLabel(update.status as FeedbackStatus)}</Badge><time dateTime={update.created_at}>{formatDateTime(update.created_at)}</time></div>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-[var(--text-primary)]">{update.body}</p>
                  </li>
                ))}
              </ol>
            )}
            {!archived && (
              <form className="mt-4 flex items-end gap-2" onSubmit={(event) => void publish(event)}>
                <Field label="新增公开进展" srOnlyLabel>
                  <Textarea rows={2} maxLength={4000} className="resize-none" value={publicUpdate} onChange={(event) => setPublicUpdate(event.target.value)} placeholder="向用户同步处理进展" />
                </Field>
                <Button type="submit" size="md" disabled={publishMutation.isPending || !publicUpdate.trim()}><PaperPlaneTilt aria-hidden className="size-4" />发布</Button>
              </form>
            )}
          </section>

          <section className="mt-6 border-t border-[var(--border-subtle)] pt-5">
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">关联 Submission</h3>
            <div className="mt-3 space-y-3">
              {detail.submissions.map((submission) => (
                <details key={submission.submission_id} className="rounded-md border border-[var(--border-subtle)] px-3 py-2.5">
                  <summary className="cursor-pointer text-sm font-medium text-[var(--text-primary)]">Submission #{submission.submission_id} · {submissionStateLabel(submission.state)}</summary>
                  <p className="mt-2 whitespace-pre-wrap text-sm text-[var(--text-primary)]">{submission.message}</p>
                  {detail.messages.filter((message) => message.submission_id === submission.submission_id).map((message) => (
                    <div key={message.id} className="mt-2 rounded-md bg-[var(--surface-hover)] px-2.5 py-2 text-xs">
                      <p className="font-medium text-[var(--text-secondary)]">{message.author_kind === 'admin' ? '管理员' : '用户'} · {formatDateTime(message.created_at)}</p>
                      <p className="mt-1 whitespace-pre-wrap text-[var(--text-primary)]">{message.body}</p>
                    </div>
                  ))}
                  {submission.context !== undefined && <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-[var(--surface-0)] p-2 font-mono text-[10px] leading-4 text-[var(--text-secondary)]">{JSON.stringify(submission.context, null, 2)}</pre>}
                </details>
              ))}
            </div>
          </section>

          {detail.audit.length > 0 && (
            <AuditTrail events={detail.audit} className="mt-6 border-t border-[var(--border-subtle)] pt-5" />
          )}
        </div>

        <aside className="border-t border-[var(--border-subtle)] px-4 py-4 xl:border-t-0">
          <SectionHeading title="事项操作" description="理由会保存在不可变审计记录中" />
          <div className="mt-4">
            <Field label="操作理由" hint={`${actionReasonBytes}/3072 bytes`} error={actionReasonBytes > 3 * 1024 ? '编码后不能超过 3 KiB' : undefined}>
              <Textarea rows={3} maxLength={4000} value={actionReason} onChange={(event) => setActionReason(event.target.value)} />
            </Field>
          </div>

          {!archived && (
            <div className="mt-4 flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <Field label="合并到 Feedback ID">
                  <Input inputMode="numeric" value={mergeTarget} onChange={(event) => setMergeTarget(event.target.value.replace(/\D/g, ''))} placeholder="目标 ID" />
                </Field>
              </div>
              <Button size="md" disabled={!validActionReason || !positiveInteger(mergeTarget) || Number(mergeTarget) === item.feedback_id || mergeMutation.isPending} onClick={() => void merge()}>
                <GitMerge aria-hidden className="size-4" />合并
              </Button>
            </div>
          )}

          <div className="mt-5 border-t border-[var(--border-subtle)] pt-4">
            <Button block variant={archived ? 'secondary' : 'ghost-danger'} disabled={!validActionReason || archiveMutation.isPending || item.merged_into_id != null} onClick={() => void moveArchive()}>
              <Archive aria-hidden className="size-4" />{archived ? '恢复到反馈事项' : '归档反馈事项'}
            </Button>
            {item.merged_into_id && <p className="mt-2 text-xs text-[var(--text-secondary)]">该记录由合并产生，已转入 Feedback #{item.merged_into_id}，不能单独恢复。</p>}
          </div>

          {error && <p role="alert" className="mt-4 text-sm text-[var(--danger)]">{error}</p>}
        </aside>
      </div>
    </Card>
  )
}

function DetailText({ label, value }: { label: string; value: string }) {
  return <div className="mt-3"><p className="text-xs font-semibold text-[var(--text-secondary)]">{label}</p><p className="mt-1 whitespace-pre-wrap text-sm text-[var(--text-primary)]">{value}</p></div>
}

function AuditTrail({ events, className = '' }: { events: FeedbackDetailResponse['audit']; className?: string }) {
  return (
    <details className={className}>
      <summary className="cursor-pointer text-sm font-semibold text-[var(--text-primary)]">审计记录（{events.length}）</summary>
      <ol className="mt-3 space-y-2">
        {events.map((event) => (
          <li key={event.id} className="rounded-md bg-[var(--surface-hover)] px-3 py-2 text-xs">
            <div className="flex flex-wrap justify-between gap-2"><span className="font-mono text-[var(--text-primary)]">{event.event_type}</span><time className="text-[var(--text-tertiary)]" dateTime={event.created_at}>{formatDateTime(event.created_at)}</time></div>
            <pre className="mt-1 overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-4 text-[var(--text-secondary)]">{JSON.stringify(event.metadata, null, 2)}</pre>
          </li>
        ))}
      </ol>
    </details>
  )
}

function PanelPlaceholder({ icon, message }: { icon: ReactNode; message: string }) {
  return (
    <Card className="flex min-h-60 flex-col items-center justify-center gap-3 text-center text-[var(--text-tertiary)]">
      {icon}
      <p className="text-sm">{message}</p>
    </Card>
  )
}

function Meta({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-[var(--text-tertiary)]">{label}</dt><dd className="mt-0.5 font-mono text-[var(--text-primary)]">{value}</dd></div>
}

function positiveInteger(value: string): boolean {
  return /^[1-9]\d*$/.test(value)
}

function auditReasonBytes(value: string): number {
  return new TextEncoder().encode(JSON.stringify({ reason: value.trim() })).length
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof AbeiApiError) return error.message
  if (error instanceof Error) return error.message
  return fallback
}

function kindLabel(kind: FeedbackKind): string {
  return { bug: '问题', experience: '体验', suggestion: '建议' }[kind]
}

function targetLabel(target: FeedbackTarget): string {
  return { cli: 'CLI', app: 'App', web: '网页' }[target]
}

function statusLabel(status: FeedbackStatus): string {
  return { open: '待处理', reviewing: '评估中', planned: '已计划', in_progress: '处理中', completed: '已完成', closed: '已关闭' }[status]
}

function severityLabel(severity: FeedbackSeverity): string {
  return { critical: '紧急', high: '高', normal: '普通', low: '低' }[severity]
}

function submissionStateLabel(state: string): string {
  return { pending_confirmation: '待用户确认', needs_confirmation: '待用户确认', linked: '已归一', needs_information: '待用户补充', dismissed: '已驳回', redacted: '已脱敏' }[state] ?? state
}

function kindTone(kind: FeedbackKind): BadgeTone {
  return kind === 'bug' ? 'danger' : kind === 'experience' ? 'attention' : 'brand'
}

function statusTone(status: FeedbackStatus): BadgeTone {
  if (status === 'completed') return 'done'
  if (status === 'closed') return 'neutral'
  if (status === 'in_progress' || status === 'planned') return 'brand'
  if (status === 'reviewing') return 'attention'
  return 'neutral'
}

function severityTone(severity: FeedbackSeverity): BadgeTone {
  if (severity === 'critical' || severity === 'high') return 'danger'
  if (severity === 'normal') return 'attention'
  return 'neutral'
}

function submissionTone(state: string): BadgeTone {
  if (state === 'needs_information' || state === 'pending_confirmation') return 'attention'
  if (state === 'linked') return 'done'
  if (state === 'redacted' || state === 'dismissed') return 'neutral'
  return 'brand'
}
