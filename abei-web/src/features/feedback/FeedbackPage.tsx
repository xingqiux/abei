import { useRef, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowClockwise,
  CaretDown,
  CaretUp,
  ChatCircleDots,
  SlidersHorizontal,
  PaperPlaneTilt,
} from '@phosphor-icons/react'
import {
  confirmFeedback,
  createFeedback,
  feedbackIdempotencyKey,
  getFeedback,
  getSession,
  listFeedback,
  replyFeedback,
  type FeedbackCandidate,
  type FeedbackItem,
  type FeedbackKind,
  type FeedbackStatus,
  type FeedbackTarget,
  type PendingFeedbackSubmission,
} from '../../api/feedback'
import { AbeiApiError } from '../../api/client'
import { ErrorState } from '../../components/abei/ErrorState'
import { Modal } from '../../components/abei/Modal'
import { Badge, type BadgeTone } from '../../components/ui/Badge'
import { Button, buttonClass } from '../../components/ui/Button'
import { Card, SectionHeading } from '../../components/ui/Card'
import { Field, Textarea } from '../../components/ui/Field'
import { SegmentedControl } from '../../components/ui/SegmentedControl'
import { adminUrl } from '../../lib/adminUrl'
import { formatDateTime } from '../../lib/format'
import { showToast } from '../../store/toastStore'

const KIND_OPTIONS = [
  { value: 'bug', label: '问题' },
  { value: 'experience', label: '体验' },
  { value: 'suggestion', label: '建议' },
] as const

const TARGET_OPTIONS = [
  { value: 'web', label: '网页' },
  { value: 'cli', label: 'CLI' },
  { value: 'app', label: 'App' },
] as const

interface SimilarityDecision {
  submissionId: number
  message: string
  candidates: FeedbackCandidate[]
}

export function FeedbackPage() {
  const queryClient = useQueryClient()
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [decision, setDecision] = useState<SimilarityDecision | null>(null)
  const sessionQuery = useQuery({
    queryKey: ['session'],
    queryFn: getSession,
    staleTime: 5 * 60_000,
  })
  const listQuery = useQuery({
    queryKey: ['feedback'],
    queryFn: () => listFeedback({ limit: 100 }),
  })
  // 反馈管理已经搬去 abei-admin，是另一个源，只能给绝对地址（没配就不显示这个入口）
  const adminHref = adminUrl('/feedback')

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['feedback'] })
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-[var(--text-primary)]">反馈</h1>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">问题、体验和建议</p>
        </div>
        {sessionQuery.data?.data.is_owner && adminHref && (
          <a
            href={adminHref}
            className={buttonClass({ variant: 'secondary', size: 'md' })}
          >
            <SlidersHorizontal aria-hidden className="size-4" />
            管理反馈
          </a>
        )}
      </header>

      <div className="grid items-start gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
        <FeedbackForm
          onCreated={async (result, message) => {
            await refresh()
            if (result.state === 'needs_confirmation' && result.candidates?.length) {
              setDecision({
                submissionId: result.submission_id,
                message,
                candidates: result.candidates,
              })
            } else if (result.feedback_id) {
              setExpandedId(result.feedback_id)
            }
          }}
        />

        <Card padded={false} className="min-w-0 overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-4 py-3">
            <SectionHeading title="我的反馈" />
            <Button
              variant="ghost"
              size="sm"
              disabled={listQuery.isFetching}
              onClick={() => void listQuery.refetch()}
            >
              <ArrowClockwise aria-hidden className={`size-4 ${listQuery.isFetching ? 'animate-spin' : ''}`} />
              刷新
            </Button>
          </div>

          {listQuery.isLoading ? (
            <p role="status" className="px-4 py-12 text-center text-sm text-[var(--text-secondary)]">正在读取反馈…</p>
          ) : listQuery.isError ? (
            <ErrorState message="反馈加载失败" error={listQuery.error} onRetry={() => void listQuery.refetch()} />
          ) : (
            <>
              {(listQuery.data?.pending.length ?? 0) > 0 && (
                <section aria-labelledby="pending-feedback-heading" className="border-b border-[var(--border-subtle)] bg-[var(--attention-soft)]/45">
                  <h2 id="pending-feedback-heading" className="px-4 pt-3 text-xs font-semibold text-[var(--attention)]">
                    待处理
                  </h2>
                  <ul role="list" className="divide-y divide-[var(--border-subtle)]">
                    {listQuery.data?.pending.map((submission) => submission.state === 'needs_information' ? (
                      <InformationRequestRow key={submission.submission_id} submission={submission} onReplied={refresh} />
                    ) : (
                      <PendingRow
                        key={submission.submission_id}
                        submission={submission}
                        onDecide={() => setDecision({
                          submissionId: submission.submission_id,
                          message: submission.message,
                          candidates: submission.candidates,
                        })}
                      />
                    ))}
                  </ul>
                </section>
              )}

              {(listQuery.data?.data.length ?? 0) === 0 ? (
                <p className="px-4 py-14 text-center text-sm text-[var(--text-secondary)]">还没有已提交的反馈</p>
              ) : (
                <ul role="list" className="divide-y divide-[var(--border-subtle)]">
                  {listQuery.data?.data.map((item) => (
                    <FeedbackRow
                      key={item.feedback_id}
                      item={item}
                      expanded={expandedId === item.feedback_id}
                      onToggle={() => setExpandedId(expandedId === item.feedback_id ? null : item.feedback_id)}
                    />
                  ))}
                </ul>
              )}
            </>
          )}
        </Card>
      </div>

      {decision && (
        <SimilarityDialog
          decision={decision}
          onClose={() => setDecision(null)}
          onConfirmed={async (feedbackId) => {
            setDecision(null)
            await refresh()
            setExpandedId(feedbackId)
          }}
        />
      )}
    </div>
  )
}

function FeedbackForm({
  onCreated,
}: {
  onCreated: (
    result: Awaited<ReturnType<typeof createFeedback>>,
    message: string,
  ) => Promise<void>
}) {
  const [kind, setKind] = useState<FeedbackKind>('bug')
  const [target, setTarget] = useState<FeedbackTarget>('web')
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const attempt = useRef<{ signature: string; key: string } | null>(null)
  const mutation = useMutation({
    mutationFn: ({ key, text }: { key: string; text: string }) => createFeedback(
      { kind, target, message: text },
      key,
    ),
  })

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const text = message.trim()
    if (!text) return
    setError(null)
    const signature = JSON.stringify({ kind, target, text })
    if (attempt.current?.signature !== signature) {
      attempt.current = { signature, key: feedbackIdempotencyKey() }
    }
    try {
      const result = await mutation.mutateAsync({ key: attempt.current.key, text })
      attempt.current = null
      setMessage('')
      await onCreated(result, text)
      showToast({
        kind: result.state === 'needs_confirmation' ? 'inbox' : 'success',
        message: result.state === 'needs_confirmation' ? '请选择是否为同一问题' : '反馈已提交',
      })
    } catch (caught) {
      setError(errorMessage(caught, '反馈提交失败'))
    }
  }

  return (
    <Card>
      <SectionHeading title="提交反馈" className="mb-4" />
      <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm/6 font-medium text-[var(--text-primary)]">类型</span>
          <SegmentedControl aria-label="反馈类型" value={kind} onChange={setKind} segments={KIND_OPTIONS} />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm/6 font-medium text-[var(--text-primary)]">反馈对象</span>
          <SegmentedControl aria-label="反馈对象" value={target} onChange={setTarget} segments={TARGET_OPTIONS} />
        </div>
        <Field label="描述" hint={`${message.length}/4000`} error={error ?? undefined}>
          <Textarea
            required
            rows={7}
            maxLength={4000}
            value={message}
            onChange={(event) => {
              setMessage(event.target.value)
              setError(null)
            }}
            placeholder="发生了什么？"
          />
        </Field>
        <Button type="submit" variant="primary" size="md" block disabled={mutation.isPending || !message.trim()}>
          <PaperPlaneTilt aria-hidden className="size-4" />
          {mutation.isPending ? '提交中…' : '提交'}
        </Button>
      </form>
    </Card>
  )
}

function PendingRow({
  submission,
  onDecide,
}: {
  submission: PendingFeedbackSubmission
  onDecide: () => void
}) {
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={kindTone(submission.kind)}>{kindLabel(submission.kind)}</Badge>
          <Badge>{targetLabel(submission.target)}</Badge>
          <span className="text-xs text-[var(--text-tertiary)]">Submission #{submission.submission_id}</span>
        </div>
        <p className="mt-1.5 line-clamp-2 text-sm text-[var(--text-primary)]">{submission.message}</p>
      </div>
      <Button variant="secondary" size="sm" onClick={onDecide}>确认相似项</Button>
    </li>
  )
}

function InformationRequestRow({
  submission,
  onReplied,
}: {
  submission: PendingFeedbackSubmission
  onReplied: () => Promise<void>
}) {
  const [reply, setReply] = useState('')
  const [error, setError] = useState<string | null>(null)
  const mutation = useMutation({
    mutationFn: () => replyFeedback(submission.submission_id, reply.trim()),
  })
  const latestRequest = [...submission.messages].reverse().find((message) => message.author_kind === 'admin')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!reply.trim()) return
    setError(null)
    try {
      await mutation.mutateAsync()
      setReply('')
      await onReplied()
      showToast({ kind: 'success', message: '补充已发送，请确认相似反馈' })
    } catch (caught) {
      setError(errorMessage(caught, '发送失败'))
    }
  }

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="attention">待补充</Badge>
        <Badge tone={kindTone(submission.kind)}>{kindLabel(submission.kind)}</Badge>
        <Badge>{targetLabel(submission.target)}</Badge>
        <span className="text-xs text-[var(--text-tertiary)]">Submission #{submission.submission_id}</span>
      </div>
      <p className="mt-2 line-clamp-2 text-sm text-[var(--text-primary)]">{submission.message}</p>
      {latestRequest && (
        <div className="mt-2 rounded-md bg-[var(--surface-1)] px-3 py-2 text-sm ring-1 ring-[var(--border-subtle)]">
          <p className="text-xs font-semibold text-[var(--text-secondary)]">管理员追问</p>
          <p className="mt-1 whitespace-pre-wrap text-[var(--text-primary)]">{latestRequest.body}</p>
        </div>
      )}
      <form className="mt-2 flex items-end gap-2" onSubmit={(event) => void submit(event)}>
        <Field label="补充信息" srOnlyLabel error={error ?? undefined}>
          <Textarea rows={2} maxLength={4000} className="resize-none" value={reply} onChange={(event) => setReply(event.target.value)} placeholder="回复管理员" />
        </Field>
        <Button type="submit" size="md" disabled={mutation.isPending || !reply.trim()}>
          <ChatCircleDots aria-hidden className="size-4" />回复
        </Button>
      </form>
    </li>
  )
}

function FeedbackRow({
  item,
  expanded,
  onToggle,
}: {
  item: FeedbackItem
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <li>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--surface-hover)]"
      >
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-[var(--text-primary)]">{item.title}</span>
            <Badge tone={statusTone(item.status)}>{statusLabel(item.status)}</Badge>
            <Badge tone={kindTone(item.kind)}>{kindLabel(item.kind)}</Badge>
            <Badge>{targetLabel(item.target)}</Badge>
          </span>
          <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--text-secondary)]">
            <span>#{item.feedback_id}</span>
            <span>{item.affected_users} 人 · {item.occurrences} 次</span>
            <time dateTime={item.updated_at}>更新于 {formatDateTime(item.updated_at)}</time>
          </span>
        </span>
        {expanded
          ? <CaretUp aria-hidden className="mt-1 size-4 shrink-0 text-[var(--text-tertiary)]" />
          : <CaretDown aria-hidden className="mt-1 size-4 shrink-0 text-[var(--text-tertiary)]" />}
      </button>
      {expanded && <FeedbackDetail feedbackId={item.feedback_id} />}
    </li>
  )
}

function FeedbackDetail({ feedbackId }: { feedbackId: number }) {
  const queryClient = useQueryClient()
  const [reply, setReply] = useState('')
  const [error, setError] = useState<string | null>(null)
  const query = useQuery({
    queryKey: ['feedback', feedbackId],
    queryFn: () => getFeedback(feedbackId),
  })
  const submissionId = query.data?.submissions.find((item) => item.state === 'needs_information')?.submission_id
    ?? query.data?.submissions[0]?.submission_id
  const replyMutation = useMutation({
    mutationFn: () => replyFeedback(submissionId as number, reply.trim()),
  })

  async function sendReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!submissionId || !reply.trim()) return
    setError(null)
    try {
      await replyMutation.mutateAsync()
      setReply('')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['feedback', feedbackId] }),
        queryClient.invalidateQueries({ queryKey: ['feedback'] }),
      ])
      showToast({ kind: 'success', message: '补充已发送' })
    } catch (caught) {
      setError(errorMessage(caught, '发送失败'))
    }
  }

  if (query.isLoading) {
    return <p role="status" className="border-t border-[var(--border-subtle)] bg-[var(--surface-hover)] px-4 py-5 text-sm text-[var(--text-secondary)]">正在读取详情…</p>
  }
  if (query.isError) {
    return <div className="border-t border-[var(--border-subtle)]"><ErrorState message="反馈详情加载失败" error={query.error} onRetry={() => void query.refetch()} /></div>
  }
  if (!query.data) return null

  return (
    <div className="border-t border-[var(--border-subtle)] bg-[var(--surface-hover)] px-4 py-4">
      {query.data.data.public_summary && (
        <p className="whitespace-pre-wrap text-sm leading-6 text-[var(--text-primary)]">{query.data.data.public_summary}</p>
      )}
      {query.data.data.close_reason && (
        <p className="mt-2 text-sm text-[var(--text-secondary)]">结论：{query.data.data.close_reason}</p>
      )}

      {query.data.updates.length > 0 && (
        <section className="mt-4">
          <h3 className="text-xs font-semibold text-[var(--text-secondary)]">处理进展</h3>
          <ol className="mt-2 border-l-2 border-[var(--border-subtle)] pl-3">
            {query.data.updates.map((update) => (
              <li key={update.id} className="mb-3 last:mb-0">
                <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-tertiary)]">
                  <Badge tone={statusTone(update.status as FeedbackStatus)}>{statusLabel(update.status as FeedbackStatus)}</Badge>
                  <time dateTime={update.created_at}>{formatDateTime(update.created_at)}</time>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-sm text-[var(--text-primary)]">{update.body}</p>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="mt-4">
        <h3 className="text-xs font-semibold text-[var(--text-secondary)]">我的提交</h3>
        <div className="mt-2 space-y-2">
          {query.data.submissions.map((submission) => (
            <div key={submission.submission_id} className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface-1)] px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-tertiary)]">
                <span>Submission #{submission.submission_id}</span>
                <Badge tone={submission.state === 'needs_information' ? 'attention' : 'neutral'}>
                  {submissionStateLabel(submission.state)}
                </Badge>
              </div>
              <p className="mt-1.5 whitespace-pre-wrap text-sm text-[var(--text-primary)]">{submission.message}</p>
            </div>
          ))}
        </div>
      </section>

      {query.data.messages.length > 0 && (
        <section className="mt-4">
          <h3 className="text-xs font-semibold text-[var(--text-secondary)]">对话</h3>
          <div className="mt-2 space-y-2">
            {query.data.messages.map((message) => (
              <div key={message.id} className={`flex ${message.author_kind === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[86%] rounded-md px-3 py-2 text-sm ${message.author_kind === 'user' ? 'bg-[var(--brand-soft)] text-[var(--text-primary)]' : 'bg-[var(--surface-1)] text-[var(--text-primary)] ring-1 ring-[var(--border-subtle)]'}`}>
                  <p className="whitespace-pre-wrap">{message.body}</p>
                  <p className="mt-1 text-[10px] text-[var(--text-tertiary)]">{formatDateTime(message.created_at)}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {submissionId && (
        <form className="mt-4 flex items-end gap-2" onSubmit={(event) => void sendReply(event)}>
          <Field label="补充信息" srOnlyLabel error={error ?? undefined}>
            <Textarea
              rows={2}
              maxLength={4000}
              value={reply}
              onChange={(event) => {
                setReply(event.target.value)
                setError(null)
              }}
              placeholder="补充信息"
              className="resize-none"
            />
          </Field>
          <Button type="submit" variant="secondary" size="md" disabled={replyMutation.isPending || !reply.trim()}>
            <ChatCircleDots aria-hidden className="size-4" />
            回复
          </Button>
        </form>
      )}
    </div>
  )
}

function SimilarityDialog({
  decision,
  onClose,
  onConfirmed,
}: {
  decision: SimilarityDecision
  onClose: () => void
  onConfirmed: (feedbackId: number) => Promise<void>
}) {
  const [error, setError] = useState<string | null>(null)
  const mutation = useMutation({
    mutationFn: (choice: { same_as: number } | { new: true }) => confirmFeedback(decision.submissionId, choice),
  })

  async function choose(choice: { same_as: number } | { new: true }) {
    setError(null)
    try {
      const result = await mutation.mutateAsync(choice)
      if (!result.feedback_id) throw new Error('确认结果没有 feedback_id')
      showToast({ kind: 'success', message: '反馈已确认' })
      await onConfirmed(result.feedback_id)
    } catch (caught) {
      setError(errorMessage(caught, '确认失败'))
    }
  }

  return (
    <Modal open onClose={onClose} title="确认相似反馈" width={620}>
      <p className="mb-3 whitespace-pre-wrap text-sm text-[var(--text-secondary)]">{decision.message}</p>
      <div className="divide-y divide-[var(--border-subtle)] rounded-md border border-[var(--border-subtle)]">
        {decision.candidates.map((candidate) => (
          <div key={candidate.feedback_id} className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-[var(--text-primary)]">#{candidate.feedback_id} {candidate.title}</span>
                <Badge tone={statusTone(candidate.status as FeedbackStatus)}>{statusLabel(candidate.status as FeedbackStatus)}</Badge>
              </div>
              <p className="mt-1 text-xs text-[var(--text-secondary)]">{candidate.affected_users} 人 · {candidate.occurrences} 次</p>
            </div>
            <Button size="sm" variant="secondary" disabled={mutation.isPending} onClick={() => void choose({ same_as: candidate.feedback_id })}>
              是同一问题
            </Button>
          </div>
        ))}
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-[var(--danger)]">{error}</p>}
      <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button disabled={mutation.isPending} onClick={onClose}>稍后确认</Button>
        <Button variant="primary" disabled={mutation.isPending} onClick={() => void choose({ new: true })}>
          都不是，作为新反馈
        </Button>
      </div>
    </Modal>
  )
}

function kindLabel(kind: FeedbackKind): string {
  return { bug: '问题', experience: '体验', suggestion: '建议' }[kind]
}

function targetLabel(target: FeedbackTarget): string {
  return { cli: 'CLI', app: 'App', web: '网页' }[target]
}

function statusLabel(status: FeedbackStatus): string {
  return {
    open: '待处理',
    reviewing: '评估中',
    planned: '已计划',
    in_progress: '处理中',
    completed: '已完成',
    closed: '已关闭',
  }[status]
}

function submissionStateLabel(state: string): string {
  return {
    pending_confirmation: '待确认',
    needs_confirmation: '待确认',
    linked: '已归一',
    needs_information: '待补充',
    dismissed: '已驳回',
    redacted: '已脱敏',
  }[state] ?? state
}

function kindTone(kind: FeedbackKind): BadgeTone {
  return kind === 'bug' ? 'danger' : kind === 'experience' ? 'attention' : 'brand'
}

function statusTone(status: FeedbackStatus): BadgeTone {
  if (status === 'completed') return 'done'
  if (status === 'closed') return 'neutral'
  if (status === 'in_progress') return 'brand'
  if (status === 'reviewing' || status === 'planned') return 'attention'
  return 'neutral'
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof AbeiApiError) return error.detail ?? error.message
  if (error instanceof Error) return error.message
  return fallback
}
