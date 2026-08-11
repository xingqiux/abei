import { useState, type FormEvent } from 'react'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowsClockwise, CaretDown, CaretUp, GithubLogo, PaperPlaneTilt, PencilSimple, Trash } from '@phosphor-icons/react'
import { AbeiApiError, apiDeleteJson, apiGet, apiPatch, apiPost } from '../../api/client'
import { ErrorState } from '../../components/abei/ErrorState'
import { Modal } from '../../components/abei/Modal'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Card, SectionHeading } from '../../components/ui/Card'
import { Field, Input, Select, Textarea } from '../../components/ui/Field'
import { SegmentedControl } from '../../components/ui/SegmentedControl'
import { formatDateTime } from '../../lib/format'
import { showToast } from '../../store/toastStore'

type FeedbackKind = 'bug' | 'friction' | 'idea'
type FeedbackStatus = 'open' | 'planned' | 'started' | 'completed' | 'declined' | 'duplicate'
type FeedbackFilter = 'all' | FeedbackKind

interface Feedback {
  id: number
  title: string
  body: string
  labels: string[]
  kind: FeedbackKind
  submitted_by: string
  source: 'cli' | 'web'
  status: FeedbackStatus
  response: string | null
  responded_by: string | null
  responded_at: string | null
  duplicate_of: number | null
  sync_status: 'local' | 'synced' | 'failed'
  github_issue_url: string | null
  github_issue_number: number | null
  sync_error: string | null
  created_at: string
  updated_at: string
}

interface FeedbackPageData {
  data: Feedback[]
  pagination: { count: number; limit: number; offset: number }
  permissions?: { manage: boolean }
}

const LIMIT = 20
const SUBMITTED_BY_KEY = 'abei.feedback.submitted-by'
const KIND_OPTIONS = [
  { value: 'bug', label: 'bug' },
  { value: 'friction', label: 'friction' },
  { value: 'idea', label: 'idea' },
] as const
const STATUS_OPTIONS: { value: FeedbackStatus; label: string }[] = [
  { value: 'open', label: '待处理' },
  { value: 'planned', label: '已计划' },
  { value: 'started', label: '处理中' },
  { value: 'completed', label: '已解决' },
  { value: 'declined', label: '不处理' },
  { value: 'duplicate', label: '重复' },
]

function savedSubmittedBy(): string {
  try {
    return localStorage.getItem(SUBMITTED_BY_KEY) ?? ''
  } catch {
    return ''
  }
}

function rememberSubmittedBy(value: string): void {
  try {
    localStorage.setItem(SUBMITTED_BY_KEY, value)
  } catch {
    // 反馈已经提交成功；浏览器禁用存储不应把成功伪装成失败。
  }
}

export function FeedbackPage() {
  const [filter, setFilter] = useState<FeedbackFilter>('all')
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const queryClient = useQueryClient()
  const query = useInfiniteQuery({
    queryKey: ['feedback', filter],
    queryFn: ({ pageParam }) => apiGet<FeedbackPageData>('/v1/feedback', {
      kind: filter === 'all' ? undefined : filter,
      limit: LIMIT,
      offset: pageParam,
    }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.pagination.count === LIMIT
      ? lastPage.pagination.offset + LIMIT
      : undefined,
  })
  const feedback = query.data?.pages.flatMap((page) => page.data) ?? []
  const canManage = query.data?.pages[0]?.permissions?.manage ?? false
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['feedback'] })

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold text-[var(--text-primary)]">反馈</h1>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          AI 和终端用户也可以用 <code className="rounded bg-[var(--surface-hover)] px-1.5 py-0.5 font-mono text-xs text-[var(--text-primary)]">abei feedback create</code> 提交。
        </p>
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card padded={false}>
          <div className="flex flex-col gap-3 border-b border-[var(--border-subtle)] p-4 sm:flex-row sm:items-center sm:justify-between">
            <SectionHeading title="反馈记录" />
            <SegmentedControl
              aria-label="按反馈类型筛选"
              value={filter}
              onChange={setFilter}
              segments={[
                { value: 'all', label: '全部' },
                ...KIND_OPTIONS,
              ]}
              className="overflow-x-auto"
            />
          </div>

          {query.isLoading ? (
            <p role="status" className="p-8 text-center text-sm text-[var(--text-secondary)]">正在加载反馈…</p>
          ) : query.isError ? (
            <ErrorState message="反馈加载失败" error={query.error} onRetry={() => void query.refetch()} />
          ) : feedback.length === 0 ? (
            <p className="p-8 text-center text-sm text-[var(--text-secondary)]">还没有反馈</p>
          ) : (
            <ul role="list" className="divide-y divide-[var(--border-subtle)]">
              {feedback.map((item) => {
                const expanded = item.id === expandedId
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      aria-expanded={expanded}
                      onClick={() => setExpandedId(expanded ? null : item.id)}
                      className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--surface-hover)]"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-[var(--text-primary)]">{item.title}</span>
                          <Badge tone={kindTone(item.kind)}>{item.kind}</Badge>
                          <Badge>{statusLabel(item.status)}</Badge>
                          {item.labels.map((label) => <Badge key={label}>{label}</Badge>)}
                        </span>
                        <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--text-secondary)]">
                          <span>{item.submitted_by}</span>
                          <span aria-hidden>·</span>
                          <time dateTime={item.created_at}>{formatDateTime(item.created_at)}</time>
                          <span aria-hidden>·</span>
                          <SyncLabel status={item.sync_status} />
                        </span>
                      </span>
                      {expanded
                        ? <CaretUp aria-hidden className="mt-1 size-4 shrink-0 text-[var(--text-tertiary)]" />
                        : <CaretDown aria-hidden className="mt-1 size-4 shrink-0 text-[var(--text-tertiary)]" />}
                    </button>
                    {expanded && (
                      <FeedbackDetail feedback={item} canManage={canManage} onChanged={refresh} />
                    )}
                  </li>
                )
              })}
            </ul>
          )}

          {query.hasNextPage && (
            <div className="flex justify-center border-t border-[var(--border-subtle)] p-3">
              <Button disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
                {query.isFetchingNextPage ? '加载中…' : '加载更多'}
              </Button>
            </div>
          )}
        </Card>

        <FeedbackForm onCreated={refresh} />
      </div>
    </div>
  )
}

function FeedbackForm({ onCreated }: { onCreated: () => Promise<unknown> }) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [kind, setKind] = useState<FeedbackKind>('bug')
  const [labels, setLabels] = useState('')
  const [submittedBy, setSubmittedBy] = useState(savedSubmittedBy)
  const [error, setError] = useState<string | null>(null)
  const mutation = useMutation({
    mutationFn: (input: {
      title: string
      body: string
      kind: FeedbackKind
      labels: string[]
      submitted_by: string
      source: 'web'
    }) => apiPost('/v1/feedback', input, { confirm: true }),
  })

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    try {
      await mutation.mutateAsync({
        title: title.trim(),
        body: body.trim(),
        kind,
        labels: labels.split(',').map((label) => label.trim()).filter(Boolean),
        submitted_by: submittedBy.trim(),
        source: 'web',
      })
      rememberSubmittedBy(submittedBy.trim())
      setTitle('')
      setBody('')
      setLabels('')
      void onCreated()
      showToast({ kind: 'success', message: '反馈已提交' })
    } catch (caught) {
      setError(caught instanceof AbeiApiError ? (caught.detail ?? caught.message) : '反馈提交失败')
    }
  }

  return (
    <Card>
      <SectionHeading title="提交反馈" description="请写清楚问题或建议，便于后续处理。" className="mb-4" />
      <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
        <Field label="标题" hint={`${title.length}/120`}>
          <Input required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <Field label="正文">
          <Textarea
            required
            rows={9}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder={'现象：\n\n期望：\n\n复现：\n\n环境：'}
          />
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm/6 font-medium text-[var(--text-primary)]">类型</span>
          <SegmentedControl aria-label="反馈类型" value={kind} onChange={setKind} segments={KIND_OPTIONS} />
        </div>
        <Field label="标签" hint="多个标签用英文逗号分隔">
          <Input value={labels} onChange={(event) => setLabels(event.target.value)} placeholder="web, usability" />
        </Field>
        <Field label="提交人">
          <Input required value={submittedBy} onChange={(event) => setSubmittedBy(event.target.value)} />
        </Field>
        {error && <p role="alert" className="rounded-md bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]">{error}</p>}
        <Button type="submit" variant="primary" size="md" disabled={mutation.isPending} block>
          <PaperPlaneTilt aria-hidden className="size-4" />
          {mutation.isPending ? '提交中…' : '提交反馈'}
        </Button>
      </form>
    </Card>
  )
}

function FeedbackDetail({ feedback }: { feedback: Feedback }) {
  return (
    <div className="border-t border-[var(--border-subtle)] bg-[var(--surface-hover)] px-4 py-4">
      <div className="text-sm leading-6 text-[var(--text-primary)]">
        <Markdown skipHtml remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
          {feedback.body}
        </Markdown>
      </div>
      <div className="mt-4 border-t border-[var(--border-subtle)] pt-3 text-xs text-[var(--text-secondary)]">
        {feedback.response && (
          <div className="mb-3">
            <p className="font-semibold text-[var(--text-primary)]">处理说明</p>
            <p className="mt-1 whitespace-pre-wrap">{feedback.response}</p>
          </div>
        )}
        {feedback.sync_status === 'synced' && feedback.github_issue_url ? (
          <a
            href={feedback.github_issue_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-medium text-[var(--brand-text)] underline underline-offset-2"
          >
            <GithubLogo aria-hidden className="size-4" />
            查看 GitHub issue{feedback.github_issue_number ? ` #${feedback.github_issue_number}` : ''}
          </a>
        ) : feedback.sync_status === 'failed' ? (
          <p><span className="font-semibold text-[var(--danger)]">同步失败：</span>{feedback.sync_error ?? '未提供错误信息'}</p>
        ) : (
          <span>仅本地</span>
        )}
      </div>
    </div>
  )
}

function SyncLabel({ status }: { status: Feedback['sync_status'] }) {
  if (status === 'synced') return <span className="font-medium text-[var(--done)]">已同步</span>
  if (status === 'failed') return <span className="font-medium text-[var(--danger)]">同步失败</span>
  return <span>仅本地</span>
}

function kindTone(kind: FeedbackKind): 'danger' | 'attention' | 'brand' {
  if (kind === 'bug') return 'danger'
  if (kind === 'friction') return 'attention'
  return 'brand'
}

function statusLabel(status: FeedbackStatus): string {
  return {
    open: '待处理',
    planned: '已计划',
    started: '处理中',
    completed: '已解决',
    declined: '不处理',
    duplicate: '重复',
  }[status]
}

const MARKDOWN_COMPONENTS = {
  h1: ({ children }: { children?: React.ReactNode }) => <h1 className="mb-3 mt-5 text-lg font-semibold first:mt-0">{children}</h1>,
  h2: ({ children }: { children?: React.ReactNode }) => <h2 className="mb-2 mt-5 text-base font-semibold first:mt-0">{children}</h2>,
  h3: ({ children }: { children?: React.ReactNode }) => <h3 className="mb-2 mt-4 text-sm font-semibold first:mt-0">{children}</h3>,
  p: ({ children }: { children?: React.ReactNode }) => <p className="mb-3 last:mb-0">{children}</p>,
  ul: ({ children }: { children?: React.ReactNode }) => <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
  ol: ({ children }: { children?: React.ReactNode }) => <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
  blockquote: ({ children }: { children?: React.ReactNode }) => <blockquote className="my-3 border-l-2 border-[var(--border-strong)] pl-3 text-[var(--text-secondary)]">{children}</blockquote>,
  a: ({ children, href }: { children?: React.ReactNode; href?: string }) => <a className="text-[var(--brand-text)] underline underline-offset-2" href={href} target="_blank" rel="noreferrer">{children}</a>,
  code: ({ children }: { children?: React.ReactNode }) => <code className="rounded bg-[var(--surface-selected)] px-1 py-0.5 font-mono text-[0.9em]">{children}</code>,
  pre: ({ children }: { children?: React.ReactNode }) => <pre className="my-3 overflow-x-auto rounded-md bg-[var(--surface-selected)] p-3 text-xs leading-5">{children}</pre>,
}
