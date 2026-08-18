import { useEffect, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import {
  ArrowClockwise,
  DownloadSimple,
  FileMagnifyingGlass,
  LockKey,
  Warning,
  X,
} from '@phosphor-icons/react'
import {
  downloadBillArtifact,
  getBillDocument,
  getBillDocumentArtifacts,
  getBillDocumentEvents,
  getBillDocumentRevisions,
  getBillDocuments,
  reparseBillDocument,
  type BillDocument,
  type BillDocumentArtifact,
  type BillDocumentEvent,
  type BillDocumentRevision,
  type FilterableDocumentStatus,
} from '../../api/documents'
import { AbeiApiError, isEndpointMissing } from '../../api/client'
import { ConfirmDialog } from '../../components/abei/ConfirmDialog'
import { EmptyState } from '../../components/abei/EmptyState'
import { ErrorState, InlineError } from '../../components/abei/ErrorState'
import { StatusChip, type ChipKind } from '../../components/abei/StatusChip'
import { Button, IconButton } from '../../components/ui/Button'
import { CONTROL_COMPACT, Select } from '../../components/ui/Field'
import { Tabs } from '../../components/ui/Tabs'
import { formatDateTime } from '../../lib/format'
import { showToast } from '../../store/toastStore'

type DrawerTab = 'events' | 'revisions' | 'artifacts'

const DRAWER_TABS = [
  { value: 'events', label: '处理过程' },
  { value: 'revisions', label: '解析修订' },
  { value: 'artifacts', label: '产物' },
] as const

/**
 * 状态筛选项。
 *
 * 「已入账」不在这里：服务端的筛选 SQL 没有这一支，选了会一封都出不来。
 * 列表里照样会显示「已入账」这个状态，只是筛不出来——这条差异写在下方提示里，
 * 别让人以为是没数据。
 */
const STATUS_OPTIONS: Array<{ value: '' | FilterableDocumentStatus; label: string }> = [
  { value: '', label: '全部状态' },
  { value: 'failed', label: '解析失败' },
  { value: 'needs_secret', label: '待解锁' },
  { value: 'ready', label: '解析中' },
  { value: 'received', label: '待解析' },
  { value: 'parsed', label: '已解析' },
  { value: 'ignored', label: '已忽略' },
]

const PAGE_SIZE = 50
const EMPTY_DOCUMENTS: BillDocument[] = []

/**
 * 账单文档诊断台。
 *
 * 解决的是「解析失败了，然后呢」：此前后台只有一个聚合失败数，点不进去，
 * 想知道是哪封邮件、卡在哪一步、报了什么错，只能去翻服务端日志。
 * 这里把服务端早就有的 events / revisions / artifacts / reparse 四套端点接起来。
 */
export function BillDocumentsPage() {
  const navigate = useNavigate()
  const search = useRouterState({
    select: (state) => state.location.search as { status?: string; channel?: string },
  })
  const [status, setStatus] = useState<'' | FilterableDocumentStatus>(
    () => (search.status as FilterableDocumentStatus | undefined) ?? '',
  )
  const [channel, setChannel] = useState(search.channel ?? '')
  const [page, setPage] = useState(1)
  const [openId, setOpenId] = useState<string | null>(null)

  // 从别处带着筛选条件跳进来（处理统计里的「查看 N 封解析失败」）时要跟着变。
  useEffect(() => {
    setStatus((search.status as FilterableDocumentStatus | undefined) ?? '')
    setChannel(search.channel ?? '')
    setPage(1)
  }, [search.status, search.channel])

  const listQuery = useQuery({
    queryKey: ['bill-documents', status, channel, page],
    queryFn: () => getBillDocuments({
      status: status || undefined,
      channel: channel.trim() || undefined,
      page,
      limit: PAGE_SIZE,
    }),
    staleTime: 15_000,
  })

  const documents = listQuery.data?.data ?? EMPTY_DOCUMENTS
  const pagination = listQuery.data?.meta?.pagination
  const total = pagination?.total ?? documents.length
  const totalPages = pagination?.total_pages ?? 1

  function applyFilter(next: { status?: '' | FilterableDocumentStatus; channel?: string }) {
    const nextStatus = next.status ?? status
    const nextChannel = next.channel ?? channel
    setStatus(nextStatus)
    setChannel(nextChannel)
    setPage(1)
    void navigate({
      to: '/documents',
      search: {
        status: nextStatus || undefined,
        channel: nextChannel.trim() || undefined,
      },
      replace: true,
    })
  }

  // 服务端还没发布这套端点时，整页给一句人话，不要一屏「请求失败」。
  if (listQuery.isError && isEndpointMissing(listQuery.error)) {
    return (
      <div className="flex min-h-0 w-full flex-1 flex-col gap-3">
        <PageHeader />
        <InlineError message="服务端尚未更新：这套账单文档接口还没上线，等服务端发布后这里就能用。" />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col gap-3">
      <PageHeader />

      <div className="flex flex-wrap items-center gap-2">
        <Select compact aria-label="文档状态" value={status} onChange={(event) => applyFilter({ status: event.target.value as '' | FilterableDocumentStatus })}
        >
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </Select>
        <input
          aria-label="渠道标识"
          className={`${CONTROL_COMPACT} w-40 font-mono`}
          placeholder="渠道，如 cmb"
          value={channel}
          onChange={(event) => setChannel(event.target.value)}
          onBlur={(event) => applyFilter({ channel: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === 'Enter') applyFilter({ channel: (event.target as HTMLInputElement).value })
          }}
        />
        <Button
          variant="secondary"
          size="xs"
          disabled={listQuery.isFetching}
          onClick={() => void listQuery.refetch()}
        >
          <ArrowClockwise aria-hidden className={`size-3.5 ${listQuery.isFetching ? 'animate-spin' : ''}`} />
          刷新列表
        </Button>
        <span className="text-[11px] text-[var(--text-tertiary)]">
          已入账的文档在列表里标成「已入账」，但服务端不支持按它筛选。
        </span>
      </div>

      <div className="overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[var(--surface-1)]">
        {listQuery.isLoading ? (
          <p role="status" className="px-4 py-12 text-center text-sm text-[var(--text-secondary)]">正在读取账单文档…</p>
        ) : listQuery.isError ? (
          <ErrorState message="账单文档列表加载失败" error={listQuery.error} onRetry={() => void listQuery.refetch()} />
        ) : documents.length === 0 ? (
          <EmptyState
            compact
            icon={<FileMagnifyingGlass className="size-7" />}
            message={status || channel ? '当前筛选下没有账单文档' : '还没有账单文档。邮件匹配到带解析流程的规则之后才会生成。'}
            action={{ label: '去邮件工作台', to: '/mail' }}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] text-left text-xs">
              <thead className="bg-[var(--surface-0)] text-[var(--text-secondary)]">
                <tr>
                  <th className="px-3 py-2 font-semibold">渠道</th>
                  <th className="px-3 py-2 font-semibold">邮件主题</th>
                  <th className="px-3 py-2 font-semibold">收到时间</th>
                  <th className="px-3 py-2 font-semibold">状态</th>
                  <th className="px-3 py-2 font-semibold">账单行</th>
                  <th className="px-3 py-2 font-semibold">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-subtle)]">
                {documents.map((document) => (
                  <DocumentRow key={document.id} document={document} onOpen={() => setOpenId(document.id)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex items-center justify-between gap-2 border-t border-[var(--border-subtle)] px-3 py-2 text-[11px] text-[var(--text-tertiary)]">
          <span>共 {total} 份</span>
          {totalPages > 1 && (
            <span className="flex items-center gap-1">
              <Button size="xs" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</Button>
              <span>{page} / {totalPages}</span>
              <Button size="xs" variant="ghost" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>下一页</Button>
            </span>
          )}
        </div>
      </div>

      {openId && <DocumentDrawer id={openId} onClose={() => setOpenId(null)} />}
    </div>
  )
}

function PageHeader() {
  return (
    <header className="min-w-0">
      <h1 className="text-xl font-semibold text-[var(--text-primary)]">账单文档</h1>
      <p className="mt-1 text-sm text-[var(--text-secondary)]">
        每封账单邮件解析成账单行的那条记录。解析失败、待解锁的都能在这里看到卡在哪一步，并重新解析。
      </p>
    </header>
  )
}

function DocumentRow({ document, onOpen }: { document: BillDocument; onOpen: () => void }) {
  const attributes = document.attributes
  const counts = attributes.row_counts
  return (
    <tr className="hover:bg-[var(--surface-hover)]">
      <td className="px-3 py-2 font-mono text-[var(--text-secondary)]">{attributes.channel_key}</td>
      <td className="max-w-80 px-3 py-2">
        <button type="button" className="block max-w-full truncate text-left font-medium text-[var(--text-primary)] hover:underline" onClick={onOpen}>
          {attributes.subject || '无主题'}
        </button>
        {attributes.error_message && (
          <span className="mt-0.5 block max-w-full truncate text-[11px] text-[var(--danger)]">{attributes.error_message}</span>
        )}
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-[var(--text-secondary)]">
        {attributes.received_at ? formatDateTime(attributes.received_at) : '时间未知'}
      </td>
      <td className="px-3 py-2"><StatusChip label={statusLabel(attributes.status)} kind={statusKind(attributes.status)} /></td>
      <td className="whitespace-nowrap px-3 py-2 text-[var(--text-secondary)]">
        {counts.total} 行
        {counts.imported > 0 && <span className="ml-1 text-[var(--done)]">已入账 {counts.imported}</span>}
        {counts.conflict > 0 && <span className="ml-1 text-[var(--danger)]">冲突 {counts.conflict}</span>}
      </td>
      <td className="px-3 py-2">
        <Button variant="ghost" size="xs" onClick={onOpen}>查看详情</Button>
      </td>
    </tr>
  )
}

/**
 * 详情抽屉。四块信息一次给全：这条文档现在什么样、处理过程走到哪、解析出过几版、留下了什么产物。
 * 「重新解析」放在这里而不是列表行上——重解析会新排一个任务，值得先看清现状再点。
 */
function DocumentDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<DrawerTab>('events')
  const [confirmOpen, setConfirmOpen] = useState(false)

  const documentQuery = useQuery({ queryKey: ['bill-document', id], queryFn: () => getBillDocument(id) })
  const eventsQuery = useQuery({
    queryKey: ['bill-document-events', id],
    queryFn: () => getBillDocumentEvents(id),
    enabled: tab === 'events',
  })
  const revisionsQuery = useQuery({
    queryKey: ['bill-document-revisions', id],
    queryFn: () => getBillDocumentRevisions(id),
    enabled: tab === 'revisions',
  })
  const artifactsQuery = useQuery({
    queryKey: ['bill-document-artifacts', id],
    queryFn: () => getBillDocumentArtifacts(id),
    enabled: tab === 'artifacts',
  })

  const reparseMutation = useMutation({
    mutationFn: () => reparseBillDocument(id),
    onSuccess: (response) => {
      setConfirmOpen(false)
      void queryClient.invalidateQueries({ queryKey: ['bill-documents'] })
      void queryClient.invalidateQueries({ queryKey: ['bill-document', id] })
      void queryClient.invalidateQueries({ queryKey: ['bill-document-events', id] })
      // 服务端返的是排队中的解析任务，不是解析结果。别说成「已重新解析」。
      showToast({
        kind: 'success',
        message: `已排队重新解析，将生成第 ${response.data.target_revision} 版结果`,
      })
    },
    onError: (error) => {
      setConfirmOpen(false)
      showToast({
        kind: 'error',
        message: isEndpointMissing(error)
          ? '服务端尚未更新：重新解析接口还没上线。'
          : error instanceof AbeiApiError ? error.message : '重新解析没能排上队',
        duration: 6000,
      })
    },
  })

  const downloadMutation = useMutation({
    mutationFn: (artifact: BillDocumentArtifact) => downloadBillArtifact(artifact),
    onError: (error) => showToast({
      kind: 'error',
      message: error instanceof AbeiApiError ? error.message : '产物下载失败',
      duration: 6000,
    }),
  })

  const document = documentQuery.data?.data
  const attributes = document?.attributes

  return (
    <div className="fixed inset-0 z-100 flex justify-end" role="dialog" aria-modal="true" aria-label="账单文档详情">
      <button type="button" aria-label="关闭详情" className="flex-1 bg-black/40" onClick={onClose} />
      <div className="flex h-full w-full max-w-[560px] flex-col bg-[var(--surface-1)] shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-[var(--border-subtle)] px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-[var(--text-primary)]">
              {attributes?.subject || `账单文档 ${id}`}
            </h2>
            <p className="mt-0.5 truncate font-mono text-[11px] text-[var(--text-tertiary)]">
              {attributes ? `${attributes.channel_key} · 解析流程 ${attributes.parser_flow_id} v${attributes.parser_flow_version}` : `#${id}`}
            </p>
          </div>
          <IconButton label="关闭详情" onClick={onClose}><X aria-hidden className="size-4" /></IconButton>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {documentQuery.isLoading ? (
            <p role="status" className="px-4 py-12 text-center text-sm text-[var(--text-secondary)]">正在读取文档详情…</p>
          ) : documentQuery.isError ? (
            <ErrorState message="账单文档详情加载失败" error={documentQuery.error} onRetry={() => void documentQuery.refetch()} />
          ) : attributes ? (
            <div className="flex flex-col gap-4 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <StatusChip label={statusLabel(attributes.status)} kind={statusKind(attributes.status)} />
                <span className="text-xs text-[var(--text-secondary)]">
                  {attributes.received_at ? formatDateTime(attributes.received_at) : '收到时间未知'}
                </span>
                <span className="text-xs text-[var(--text-secondary)]">
                  {attributes.row_counts.total} 行 · 待入账 {attributes.row_counts.pending} · 已入账 {attributes.row_counts.imported}
                </span>
              </div>

              {attributes.error_message && (
                <div className="flex items-start gap-2 rounded-md bg-[var(--danger-soft)] px-3 py-2 text-xs text-[var(--danger)]">
                  <Warning aria-hidden className="mt-0.5 size-4 shrink-0" />
                  <span className="min-w-0">
                    {attributes.error_message}
                    {attributes.error_code && <span className="ml-1 font-mono opacity-80">（{attributes.error_code}）</span>}
                  </span>
                </div>
              )}

              {attributes.status === 'needs_secret' && (
                <div className="flex items-start gap-2 rounded-md bg-[var(--attention-soft)] px-3 py-2 text-xs text-[var(--attention)]">
                  <LockKey aria-hidden className="mt-0.5 size-4 shrink-0" />
                  <span className="min-w-0">
                    {attributes.metadata.waiting_reason || '附件带密码，等用户在前台输入后才能继续解析。'}
                  </span>
                </div>
              )}

              <div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={reparseMutation.isPending || attributes.lifecycle !== 'active'}
                  title={attributes.lifecycle !== 'active' ? '已归档的文档不能重新解析' : undefined}
                  onClick={() => setConfirmOpen(true)}
                >
                  <ArrowClockwise aria-hidden className={`size-4 ${reparseMutation.isPending ? 'animate-spin' : ''}`} />
                  {reparseMutation.isPending ? '排队中…' : '重新解析这份文档'}
                </Button>
              </div>

              <div>
                <Tabs tabs={DRAWER_TABS} value={tab} onChange={setTab} aria-label="文档详情" />
                <div className="pt-3">
                  {tab === 'events' && (
                    <Panel
                      state={paneState(eventsQuery, '处理过程')}
                      empty="还没有处理记录。"
                      items={eventsQuery.data?.data}
                      render={(events) => <EventsTimeline events={events} />}
                    />
                  )}
                  {tab === 'revisions' && (
                    <Panel
                      state={paneState(revisionsQuery, '解析修订')}
                      empty="还没有解析结果。"
                      items={revisionsQuery.data?.data}
                      render={(revisions) => <RevisionList revisions={revisions} activeRevision={attributes.active_revision} />}
                    />
                  )}
                  {tab === 'artifacts' && (
                    <Panel
                      state={paneState(artifactsQuery, '产物列表')}
                      empty="这份文档没有留下产物。"
                      items={artifactsQuery.data?.data}
                      render={(artifacts) => (
                        <ArtifactList
                          artifacts={artifacts}
                          downloading={downloadMutation.isPending}
                          onDownload={(artifact) => downloadMutation.mutate(artifact)}
                        />
                      )}
                    />
                  )}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="重新解析这份文档"
        confirmLabel="重新解析"
        pendingLabel="排队中…"
        tone="primary"
        pending={reparseMutation.isPending}
        onConfirm={() => reparseMutation.mutate()}
        onClose={() => setConfirmOpen(false)}
      >
        <p>
          会用当前发布的解析流程重跑「{attributes?.subject || `账单文档 ${id}`}」，生成新一版账单行。
        </p>
        <p>已经入账的 {attributes?.row_counts.imported ?? 0} 行不会被撤回，历史修订也不会删除。</p>
      </ConfirmDialog>
    </div>
  )
}

/** 抽屉里三个页签的加载/失败/空态长一个样，抽出来免得三份各自飘。 */
interface PaneState {
  label: string
  loading: boolean
  error: unknown
  isError: boolean
  retry: () => void
}

function paneState(
  query: { isLoading: boolean; isError: boolean; error: unknown; refetch: () => unknown },
  label: string,
): PaneState {
  return {
    label,
    loading: query.isLoading,
    isError: query.isError,
    error: query.error,
    retry: () => void query.refetch(),
  }
}

function Panel<T>({
  state,
  items,
  empty,
  render,
}: {
  state: PaneState
  items: T[] | undefined
  empty: string
  render: (items: T[]) => ReactNode
}) {
  if (state.loading) {
    return <p role="status" className="py-8 text-center text-xs text-[var(--text-secondary)]">正在读取{state.label}…</p>
  }
  if (state.isError) {
    return <ErrorState message={`${state.label}加载失败`} error={state.error} onRetry={state.retry} />
  }
  if (!items || items.length === 0) {
    return <p className="py-8 text-center text-xs text-[var(--text-tertiary)]">{empty}</p>
  }
  return render(items)
}

function EventsTimeline({ events }: { events: BillDocumentEvent[] }) {
  return (
    <ol className="space-y-2">
      {events.map((event) => (
        <li key={event.id} className="rounded-md border border-[var(--border-subtle)] px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <StatusChip label={eventLabel(event.attributes.event_type)} kind={eventKind(event.attributes.event_type)} />
            <span className="text-[11px] text-[var(--text-tertiary)]">{formatDateTime(event.attributes.created_at)}</span>
          </div>
          <p className="mt-1 text-xs text-[var(--text-primary)]">{event.attributes.message}</p>
          {event.attributes.metadata.error_code && (
            <p className="mt-0.5 font-mono text-[11px] text-[var(--text-tertiary)]">{event.attributes.metadata.error_code}</p>
          )}
        </li>
      ))}
    </ol>
  )
}

function RevisionList({
  revisions,
  activeRevision,
}: {
  revisions: BillDocumentRevision[]
  activeRevision: number | null
}) {
  return (
    <ul className="space-y-2">
      {revisions.map((revision) => (
        <li key={revision.revision} className="flex items-center justify-between gap-3 rounded-md border border-[var(--border-subtle)] px-3 py-2">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-[var(--text-primary)]">
              第 {revision.revision} 版
              {revision.revision === activeRevision && <span className="ml-2 font-normal text-[var(--done)]">当前生效</span>}
            </p>
            <p className="mt-0.5 text-[11px] text-[var(--text-tertiary)]">
              流程 v{revision.parser_flow_version} · {formatDateTime(revision.created_at)}
            </p>
          </div>
          <span className="shrink-0 text-[11px] text-[var(--text-secondary)]">
            有效 {revision.valid_row_count} · 无效 {revision.invalid_row_count}
          </span>
        </li>
      ))}
    </ul>
  )
}

function ArtifactList({
  artifacts,
  downloading,
  onDownload,
}: {
  artifacts: BillDocumentArtifact[]
  downloading: boolean
  onDownload: (artifact: BillDocumentArtifact) => void
}) {
  return (
    <ul className="space-y-2">
      {artifacts.map((artifact) => (
        <li key={artifact.id} className="flex items-center justify-between gap-3 rounded-md border border-[var(--border-subtle)] px-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-[var(--text-primary)]">{artifact.attributes.filename}</p>
            <p className="mt-0.5 text-[11px] text-[var(--text-tertiary)]">
              第 {artifact.attributes.revision} 版 · {artifact.attributes.kind} · {formatBytes(artifact.attributes.size)}
              {artifact.attributes.encrypted && ' · 已加密'}
            </p>
          </div>
          <Button variant="ghost" size="xs" disabled={downloading} onClick={() => onDownload(artifact)}>
            <DownloadSimple aria-hidden className="size-3.5" />下载
          </Button>
        </li>
      ))}
    </ul>
  )
}

/** 文案照 05-文案规范的术语表：待入账/待确认/已忽略/已入账/待解锁/解析失败。 */
function statusLabel(status: string): string {
  return ({
    received: '待解析',
    ready: '解析中',
    parsed: '已解析',
    needs_secret: '待解锁',
    failed: '解析失败',
    imported: '已入账',
    ignored: '已忽略',
  } as Record<string, string>)[status] ?? status
}

function statusKind(status: string): ChipKind {
  if (status === 'failed') return 'danger'
  if (status === 'needs_secret') return 'warn'
  if (status === 'imported') return 'ok'
  if (status === 'parsed') return 'accent'
  return 'muted'
}

function eventLabel(eventType: string): string {
  return ({
    parse_job_queued: '已排队',
    parse_job_running: '解析中',
    parse_job_succeeded: '解析完成',
    parse_job_failed: '解析失败',
    parse_job_waiting_input: '待解锁',
  } as Record<string, string>)[eventType] ?? eventType
}

function eventKind(eventType: string): ChipKind {
  if (eventType === 'parse_job_failed') return 'danger'
  if (eventType === 'parse_job_waiting_input') return 'warn'
  if (eventType === 'parse_job_succeeded') return 'ok'
  return 'muted'
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / 1024 / 1024).toFixed(1)} MiB`
}
