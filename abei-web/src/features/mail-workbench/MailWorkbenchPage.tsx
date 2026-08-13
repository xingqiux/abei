import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  ArrowClockwise,
  CalendarBlank,
  CheckCircle,
  CloudArrowDown,
  DownloadSimple,
  EnvelopeOpen,
  FloppyDisk,
  Gear,
  Paperclip,
  Play,
  Plus,
  PushPinSimple,
  RocketLaunch,
  Trash,
  XCircle,
} from '@phosphor-icons/react'
import {
  createMailRule,
  createMailSample,
  cacheMailMessage,
  cancelMailSyncRun,
  downloadRawMail,
  estimateMailboxRescan,
  getMailMessage,
  getMailMessages,
  getMailRules,
  getMailSyncRuns,
  publishMailRule,
  rerouteMailMessage,
  syncMailbox,
  startMailboxRescan,
  testMailRule,
  updateMailRule,
  type MailClassification,
  type MailboxRescanInput,
  type MailDiagnostic,
  type MailMessageSummary,
  type MailMessageDetail,
  type MailRule,
  type MailRuleCondition,
  type MailRuleInput,
  type MailTextField,
  type MailTextOperator,
} from '../../api/mail'
import { getParserFlows } from '../../api/parser'
import { AbeiApiError } from '../../api/client'
import { EmptyState } from '../../components/abei/EmptyState'
import { ErrorState, InlineError } from '../../components/abei/ErrorState'
import { Modal } from '../../components/abei/Modal'
import { ProgressBar } from '../../components/abei/ProgressBar'
import { StatusChip } from '../../components/abei/StatusChip'
import { Button, IconButton } from '../../components/ui/Button'
import { CONTROL_COMPACT, Field, Input } from '../../components/ui/Field'
import { Tabs } from '../../components/ui/Tabs'
import { formatDateTime } from '../../lib/format'
import { showToast } from '../../store/toastStore'
import { BillInboxSettingsDialog } from '../bill-inbox/BillInboxSettingsDialog'

type DetailTab = 'preview' | 'headers' | 'mime' | 'attachments' | 'rules'
type RuleGroup = 'all' | 'any'

interface EditableCondition {
  key: number
  field: MailTextField
  operator: MailTextOperator
  value: string
  headerName: string
}

interface RuleForm {
  id: string | null
  name: string
  enabled: boolean
  position: number
  channelKey: string
  parserFlowId: string
  group: RuleGroup
  conditions: EditableCondition[]
  safelyEditable: boolean
}

const CLASSIFICATIONS: Array<{ value: '' | MailClassification; label: string }> = [
  { value: '', label: '全部邮件' },
  { value: 'unclassified', label: '未归类' },
  { value: 'matched', label: '已匹配' },
  { value: 'ignored', label: '已忽略' },
  { value: 'error', label: '有错误' },
]

const DETAIL_TABS = [
  { value: 'preview', label: '预览' },
  { value: 'headers', label: 'Header' },
  { value: 'mime', label: 'MIME' },
  { value: 'attachments', label: '附件' },
  { value: 'rules', label: '规则' },
] as const

const EMPTY_MESSAGES: MailMessageSummary[] = []
const EMPTY_RULES: MailRule[] = []

const FIELD_OPTIONS: Array<{ value: MailTextField; label: string }> = [
  { value: 'from', label: '发件人' },
  { value: 'to', label: '收件人' },
  { value: 'subject', label: '主题' },
  { value: 'folder', label: '文件夹' },
  { value: 'header', label: 'Header' },
  { value: 'body_text', label: '纯文本正文' },
  { value: 'body_html', label: 'HTML 正文' },
  { value: 'attachment_filename', label: '附件名' },
  { value: 'attachment_extension', label: '附件扩展名' },
  { value: 'attachment_mime', label: '附件 MIME' },
]

const OPERATOR_OPTIONS: Array<{ value: MailTextOperator; label: string }> = [
  { value: 'contains', label: '包含' },
  { value: 'equals', label: '等于' },
  { value: 'prefix', label: '开头是' },
  { value: 'suffix', label: '结尾是' },
]

let conditionKey = 1

function emptyCondition(): EditableCondition {
  return {
    key: conditionKey++,
    field: 'from',
    operator: 'contains',
    value: '',
    headerName: '',
  }
}

function emptyRule(position = 100): RuleForm {
  return {
    id: null,
    name: '',
    enabled: true,
    position,
    channelKey: '',
    parserFlowId: '',
    group: 'all',
    conditions: [emptyCondition()],
    safelyEditable: true,
  }
}

export function MailWorkbenchPage() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [classification, setClassification] = useState<'' | MailClassification>('')
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search.trim())
  const [messageOffset, setMessageOffset] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detailTab, setDetailTab] = useState<DetailTab>('preview')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [rescanOpen, setRescanOpen] = useState(false)
  const [rescanInput, setRescanInput] = useState<MailboxRescanInput>(() => defaultRescanInput())
  const [rescanEstimate, setRescanEstimate] = useState<{ key: string; estimated: number } | null>(null)
  const [ruleForm, setRuleForm] = useState<RuleForm>(() => emptyRule())
  const [testResult, setTestResult] = useState<Awaited<ReturnType<typeof testMailRule>>['data'] | null>(null)
  const [testScope, setTestScope] = useState<'current' | 'all' | null>(null)
  const autoCacheAttemptedIds = useRef(new Set<string>())

  const messagesQuery = useQuery({
    queryKey: ['mail-messages', classification, deferredSearch, messageOffset],
    queryFn: () => getMailMessages({
      classification: classification || undefined,
      search: deferredSearch || undefined,
      limit: 100,
      offset: messageOffset,
    }),
    staleTime: 15_000,
  })
  const messages = messagesQuery.data?.data ?? EMPTY_MESSAGES
  const messageTotal = messagesQuery.data?.meta?.pagination?.total ?? messages.length

  useEffect(() => setMessageOffset(0), [classification, deferredSearch])
  const detailQuery = useQuery({
    queryKey: ['mail-message', selectedId],
    queryFn: () => getMailMessage(selectedId as string),
    enabled: selectedId !== null,
  })
  const rulesQuery = useQuery({
    queryKey: ['mail-rules'],
    queryFn: getMailRules,
    staleTime: 15_000,
  })
  const rules = rulesQuery.data?.data ?? EMPTY_RULES
  const parserFlowsQuery = useQuery({
    queryKey: ['parser-flows'],
    queryFn: getParserFlows,
    staleTime: 30_000,
  })
  const parserFlows = parserFlowsQuery.data?.data.filter((flow) => flow.attributes.status === 'published') ?? []
  const syncRunsQuery = useQuery({
    queryKey: ['mail-sync-runs'],
    queryFn: () => getMailSyncRuns(10),
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchInterval: (query) => query.state.data?.data.some((run) => run.status === 'queued' || run.status === 'running') ? 1_000 : false,
  })
  const activeRun = syncRunsQuery.data?.data.find((run) => run.status === 'queued' || run.status === 'running')
    ?? syncRunsQuery.data?.data[0]
  const syncRunning = activeRun?.status === 'queued' || activeRun?.status === 'running'
  const activeTotal = numericProgress(activeRun?.progress.total)
  const activePercent = activeTotal > 0 ? (activeRun?.counts.scanned ?? 0) / activeTotal * 100 : 0
  const completedRunKey = activeRun && !syncRunning ? `${activeRun.id}:${activeRun.status}` : null

  useEffect(() => {
    if (!completedRunKey) return
    void queryClient.invalidateQueries({ queryKey: ['mail-messages'] })
    void queryClient.invalidateQueries({ queryKey: ['mail-message'] })
  }, [completedRunKey, queryClient])

  useEffect(() => {
    if (selectedId === null && messages.length > 0) setSelectedId(messages[0].id)
    if (selectedId !== null && !messages.some((message) => message.id === selectedId)) {
      setSelectedId(messages[0]?.id ?? null)
    }
  }, [messages, selectedId])

  const syncMutation = useMutation({
    mutationFn: () => syncMailbox(100),
    onSuccess: async () => {
      showToast({ kind: 'success', message: '邮件同步已开始' })
      await queryClient.invalidateQueries({ queryKey: ['mail-sync-runs'] })
    },
    onError: (error) => showToast({
      kind: 'error',
      message: error instanceof AbeiApiError ? error.message : '邮件同步启动失败',
      duration: 6000,
    }),
  })
  const estimateRescanMutation = useMutation({
    mutationFn: (input: MailboxRescanInput) => estimateMailboxRescan(input),
    onSuccess: (response, input) => setRescanEstimate({
      key: rescanKey(input),
      estimated: response.data.estimated,
    }),
    onError: mutationError('历史扫描估算失败'),
  })
  const rescanMutation = useMutation({
    mutationFn: (input: MailboxRescanInput) => startMailboxRescan(input),
    onSuccess: () => {
      setRescanOpen(false)
      setRescanEstimate(null)
      void queryClient.invalidateQueries({ queryKey: ['mail-sync-runs'] })
      showToast({ kind: 'success', message: '历史扫描已开始' })
    },
    onError: mutationError('历史扫描启动失败'),
  })
  const cancelSyncMutation = useMutation({
    mutationFn: (id: string) => cancelMailSyncRun(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mail-sync-runs'] })
      showToast({ kind: 'success', message: '邮件同步已取消' })
    },
    onError: mutationError('邮件同步取消失败'),
  })
  const rerouteMutation = useMutation({
    mutationFn: (id: string) => rerouteMailMessage(id),
    onSuccess: (response) => {
      queryClient.setQueryData(['mail-message', response.data.id], response)
      void queryClient.invalidateQueries({ queryKey: ['mail-messages'] })
      showToast({ kind: 'success', message: '已按当前规则重新归类' })
    },
    onError: mutationError('邮件重新归类失败'),
  })
  const cacheMutation = useMutation({
    mutationFn: ({ id }: { id: string; silent?: boolean }) => cacheMailMessage(id),
    onSuccess: (response, input) => {
      queryClient.setQueryData(['mail-message', response.data.id], response)
      void queryClient.invalidateQueries({ queryKey: ['mail-messages'] })
      if (!input.silent) showToast({ kind: 'success', message: '邮件原始内容已重新缓存' })
    },
    onError: mutationError('邮件重新缓存失败'),
  })

  useEffect(() => {
    const mail = detailQuery.data?.data
    if (!mail || mail.attributes.content_state === 'cached' || autoCacheAttemptedIds.current.has(mail.id)) return
    autoCacheAttemptedIds.current.add(mail.id)
    cacheMutation.mutate({ id: mail.id, silent: true })
  // The message id/state is the trigger; mutation identity changes between renders.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailQuery.data?.data.id, detailQuery.data?.data.attributes.content_state])
  const downloadMutation = useMutation({
    mutationFn: (id: string) => downloadRawMail(id),
    onError: mutationError('原始 EML 下载失败'),
  })
  const parserSampleMutation = useMutation({
    mutationFn: async (mail: MailMessageDetail) => {
      if (mail.attributes.content_state !== 'cached') await cacheMailMessage(mail.id)
      return createMailSample({
        mail_message_id: Number(mail.id),
        name: (mail.attributes.subject?.trim() || `邮件样本 ${mail.id}`).slice(0, 120),
        purpose: 'parser',
      })
    },
    onSuccess: (response) => {
      void queryClient.invalidateQueries({ queryKey: ['mail-samples'] })
      showToast({ kind: 'success', message: '已固定为解析样本' })
      void navigate({ to: '/parser-workbench', search: { sample: response.data.id } })
    },
    onError: mutationError('固定解析样本失败'),
  })

  function selectRule(rule: MailRule) {
    setRuleForm(ruleToForm(rule))
    setTestResult(null)
    setTestScope(null)
  }

  function startRule() {
    const nextPosition = rules.reduce((max, rule) => Math.max(max, rule.attributes.position), 0) + 10
    setRuleForm(emptyRule(nextPosition))
    setTestResult(null)
    setTestScope(null)
  }

  return (
    <div className="flex w-full flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-[var(--text-primary)]">邮件工作台</h1>
          {activeRun && (
            <div className="mt-1 flex max-w-xl items-center gap-2 text-xs text-[var(--text-secondary)]">
              <span className="shrink-0">
                {syncRunLabel(activeRun.status, activeRun.stage, activeRun.kind)} · 已检查 {activeRun.counts.scanned}{activeTotal > 0 ? ` / ${activeTotal}` : ''} · 匹配 {activeRun.counts.matched} · 未归类 {activeRun.counts.unclassified}
              </span>
              {activeRun.status === 'running' && activeTotal > 0 && (
                <ProgressBar pct={activePercent} label="邮件同步进度" />
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {syncRunning && (
            <Button
              variant="secondary"
              size="md"
              disabled={cancelSyncMutation.isPending}
              onClick={() => cancelSyncMutation.mutate(activeRun.id)}
            >
              <XCircle aria-hidden className="size-4" />
              取消同步
            </Button>
          )}
          <Button
            variant="secondary"
            size="md"
            disabled={syncMutation.isPending || syncRunning}
            onClick={() => syncMutation.mutate()}
          >
            <ArrowClockwise aria-hidden className={`size-4 ${syncMutation.isPending || syncRunning ? 'animate-spin' : ''}`} />
            {syncRunning ? '同步进行中' : '同步新邮件'}
          </Button>
          <Button
            variant="secondary"
            size="md"
            disabled={syncRunning}
            onClick={() => {
              setRescanInput(defaultRescanInput())
              setRescanEstimate(null)
              setRescanOpen(true)
            }}
          >
            <CalendarBlank aria-hidden className="size-4" />
            历史扫描
          </Button>
          <IconButton label="邮箱设置" variant="secondary" onClick={() => setSettingsOpen(true)}>
            <Gear aria-hidden className="size-4" />
          </IconButton>
        </div>
      </header>

      {activeRun?.status === 'failed' && activeRun.error_summary && (
        <InlineError message={activeRun.error_summary} />
      )}

      <RuleEditor
        rules={rules}
        loading={rulesQuery.isLoading}
        error={rulesQuery.error}
        form={ruleForm}
        testResult={testResult}
        parserFlows={parserFlows}
        parserFlowsLoading={parserFlowsQuery.isLoading}
        currentMessageId={selectedId}
        onFormChange={(next) => { setRuleForm(next); setTestResult(null) }}
        onSelect={selectRule}
        onNew={startRule}
        onTestResult={setTestResult}
        testScope={testScope}
        onTestScope={setTestScope}
      />

      <div className="grid min-h-[620px] overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[var(--surface-1)] lg:grid-cols-[minmax(300px,0.78fr)_minmax(0,1.5fr)]">
        <section className="flex min-h-0 flex-col border-b border-[var(--border-subtle)] lg:border-r lg:border-b-0">
          <div className="grid grid-cols-[minmax(0,1fr)_130px] gap-2 border-b border-[var(--border-subtle)] p-3">
            <input
              aria-label="搜索邮件"
              className={CONTROL_COMPACT}
              placeholder="发件人、主题、附件名"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <select
              aria-label="归类状态"
              className={CONTROL_COMPACT}
              value={classification}
              onChange={(event) => setClassification(event.target.value as '' | MailClassification)}
            >
              {CLASSIFICATIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto lg:max-h-[720px]">
            {messagesQuery.isLoading ? (
              <p role="status" className="px-4 py-10 text-center text-sm text-[var(--text-secondary)]">正在读取邮件…</p>
            ) : messagesQuery.isError ? (
              <ErrorState message="邮件列表加载失败" error={messagesQuery.error} onRetry={() => void messagesQuery.refetch()} />
            ) : messages.length === 0 ? (
              <EmptyState
                compact
                icon={<EnvelopeOpen className="size-7" />}
                message="当前范围没有邮件"
                action={{ label: '同步最近邮件', onClick: () => syncMutation.mutate() }}
              />
            ) : (
              <ul role="list" className="divide-y divide-[var(--border-subtle)]">
                {messages.map((message) => (
                  <MailListRow
                    key={message.id}
                    message={message}
                    active={message.id === selectedId}
                    onClick={() => {
                      setSelectedId(message.id)
                      setDetailTab('preview')
                    }}
                  />
                ))}
              </ul>
            )}
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-[var(--border-subtle)] px-3 py-2 text-[11px] text-[var(--text-tertiary)]">
            <span>共 {messageTotal} 封</span>
            {messageTotal > 100 && (
              <span className="flex items-center gap-1">
                <Button size="xs" variant="ghost" disabled={messageOffset === 0} onClick={() => setMessageOffset(Math.max(0, messageOffset - 100))}>上一页</Button>
                <span>{Math.floor(messageOffset / 100) + 1} / {Math.ceil(messageTotal / 100)}</span>
                <Button size="xs" variant="ghost" disabled={messageOffset + 100 >= messageTotal} onClick={() => setMessageOffset(messageOffset + 100)}>下一页</Button>
              </span>
            )}
          </div>
        </section>

        <section className="min-w-0">
          {selectedId === null ? (
            <EmptyState
              icon={<EnvelopeOpen className="size-8" />}
              message="选择一封邮件查看详情"
              action={{ label: '同步新邮件', onClick: () => syncMutation.mutate() }}
            />
          ) : detailQuery.isLoading ? (
            <p role="status" className="py-20 text-center text-sm text-[var(--text-secondary)]">正在读取邮件详情…</p>
          ) : detailQuery.isError ? (
            <ErrorState message="邮件详情加载失败" error={detailQuery.error} onRetry={() => void detailQuery.refetch()} />
          ) : detailQuery.data ? (
            <MailDetail
              mail={detailQuery.data.data}
              tab={detailTab}
              onTabChange={setDetailTab}
              onDownload={() => downloadMutation.mutate(detailQuery.data.data.id)}
              onCache={() => cacheMutation.mutate({ id: detailQuery.data.data.id })}
              onReroute={() => rerouteMutation.mutate(detailQuery.data.data.id)}
              onUseAsParserSample={() => parserSampleMutation.mutate(detailQuery.data.data)}
              caching={cacheMutation.isPending}
              rerouting={rerouteMutation.isPending}
              pinning={parserSampleMutation.isPending}
              hasRules={rules.length > 0}
            />
          ) : null}
        </section>
      </div>

      <RescanDialog
        open={rescanOpen}
        input={rescanInput}
        estimate={rescanEstimate?.key === rescanKey(rescanInput) ? rescanEstimate.estimated : null}
        estimating={estimateRescanMutation.isPending}
        starting={rescanMutation.isPending}
        onChange={(input) => {
          setRescanInput(input)
          setRescanEstimate(null)
        }}
        onEstimate={() => estimateRescanMutation.mutate(rescanInput)}
        onStart={() => rescanMutation.mutate(rescanInput)}
        onClose={() => {
          if (!estimateRescanMutation.isPending && !rescanMutation.isPending) setRescanOpen(false)
        }}
      />
      <BillInboxSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}

function RescanDialog({
  open,
  input,
  estimate,
  estimating,
  starting,
  onChange,
  onEstimate,
  onStart,
  onClose,
}: {
  open: boolean
  input: MailboxRescanInput
  estimate: number | null
  estimating: boolean
  starting: boolean
  onChange: (input: MailboxRescanInput) => void
  onEstimate: () => void
  onStart: () => void
  onClose: () => void
}) {
  const validation = validateRescanInput(input)
  const valid = validation === null
  const selected = estimate === null ? 0 : Math.min(estimate, input.limit)
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="扫描历史邮件"
      footer={
        <>
          <Button variant="secondary" size="md" disabled={estimating || starting} onClick={onClose}>取消</Button>
          <Button variant="secondary" size="md" disabled={!valid || estimating || starting} onClick={onEstimate}>
            {estimating ? '估算中…' : '估算邮件数'}
          </Button>
          <Button variant="primary" size="md" disabled={estimate === null || selected === 0 || estimating || starting} onClick={onStart}>
            {starting ? '启动中…' : `开始扫描 ${selected} 封`}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="开始日期">
          <Input
            type="date"
            value={input.from}
            max={input.to}
            onChange={(event) => onChange({ ...input, from: event.target.value })}
          />
        </Field>
        <Field label="结束日期">
          <Input
            type="date"
            value={input.to}
            min={input.from}
            onChange={(event) => onChange({ ...input, to: event.target.value })}
          />
        </Field>
        <Field label="本轮上限" hint="单次最多 500 封，超过时优先扫描最近的邮件。">
          <Input
            type="number"
            min={1}
            max={500}
            value={input.limit}
            onChange={(event) => onChange({ ...input, limit: Number(event.target.value) })}
          />
        </Field>
        {estimate !== null && (
          <div className="self-end rounded-md bg-[var(--surface-hover)] px-3 py-2 text-sm text-[var(--text-primary)]">
            范围内共 {estimate} 封，本轮将扫描 {selected} 封。
          </div>
        )}
        {validation && <p className="text-xs text-[var(--danger)] sm:col-span-2">{validation}</p>}
      </div>
    </Modal>
  )
}

function MailListRow({ message, active, onClick }: { message: MailMessageSummary; active: boolean; onClick: () => void }) {
  const attributes = message.attributes
  const attachments = attributes.body_structure.attachments?.length ?? 0
  return (
    <li>
      <button
        type="button"
        aria-current={active ? 'true' : undefined}
        onClick={onClick}
        className={`w-full px-3 py-3 text-left transition-colors ${active ? 'bg-[var(--surface-selected)]' : 'hover:bg-[var(--surface-hover)]'}`}
      >
        <span className="flex min-w-0 items-start justify-between gap-2">
          <span className="truncate text-sm font-semibold text-[var(--text-primary)]">{attributes.subject || '无主题'}</span>
          <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-tertiary)]">{shortDate(attributes.received_at)}</span>
        </span>
        <span className="mt-1 flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-secondary)]">{attributes.from_address || '未知发件人'}</span>
          {attachments > 0 && (
            <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-[var(--text-tertiary)]">
              <Paperclip aria-hidden className="size-3" />{attachments}
            </span>
          )}
          <StatusChip
            label={attributes.classification === 'matched'
              ? attributes.parser_flow_id ? attributes.channel_key || '已匹配' : '已归类 · 未解析'
              : classificationLabel(attributes.classification)}
            kind={attributes.classification === 'matched' && attributes.parser_flow_id ? 'ok' : attributes.classification === 'error' ? 'danger' : 'muted'}
          />
        </span>
      </button>
    </li>
  )
}

function MailDetail({
  mail,
  tab,
  onTabChange,
  onDownload,
  onCache,
  onReroute,
  onUseAsParserSample,
  caching,
  rerouting,
  pinning,
  hasRules,
}: {
  mail: Awaited<ReturnType<typeof getMailMessage>>['data']
  tab: DetailTab
  onTabChange: (tab: DetailTab) => void
  onDownload: () => void
  onCache: () => void
  onReroute: () => void
  onUseAsParserSample: () => void
  caching: boolean
  rerouting: boolean
  pinning: boolean
  hasRules: boolean
}) {
  const attributes = mail.attributes
  return (
    <div className="flex min-h-[620px] flex-col">
      <div className="border-b border-[var(--border-subtle)] px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="break-words text-base font-semibold text-[var(--text-primary)]">{attributes.subject || '无主题'}</h2>
            <p className="mt-1 truncate text-xs text-[var(--text-secondary)]">{attributes.from_address || '未知发件人'}</p>
            <p className="mt-0.5 text-[11px] text-[var(--text-tertiary)]">{attributes.received_at ? formatDateTime(attributes.received_at) : '时间未知'}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <IconButton label="固定为解析样本并打开解析工作台" variant="secondary" disabled={pinning} onClick={onUseAsParserSample}>
              <PushPinSimple aria-hidden className={`size-4 ${pinning ? 'animate-pulse' : ''}`} />
            </IconButton>
            <IconButton label="下载原始 EML" variant="secondary" disabled={attributes.content_state !== 'cached'} onClick={onDownload}>
              <DownloadSimple aria-hidden className="size-4" />
            </IconButton>
            {attributes.content_state !== 'cached' && (
              <IconButton label="重新缓存邮件" variant="secondary" disabled={caching} onClick={onCache}>
                <CloudArrowDown aria-hidden className={`size-4 ${caching ? 'animate-pulse' : ''}`} />
              </IconButton>
            )}
            <IconButton label="按当前规则重新归类" variant="secondary" disabled={rerouting} onClick={onReroute}>
              <ArrowClockwise aria-hidden className={`size-4 ${rerouting ? 'animate-spin' : ''}`} />
            </IconButton>
          </div>
        </div>
      </div>
      <div className="px-4 pt-3">
        <Tabs tabs={DETAIL_TABS} value={tab} onChange={onTabChange} aria-label="邮件详情" />
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {tab === 'preview' && <MailPreview preview={attributes.preview} loading={caching} onLoad={onCache} />}
        {tab === 'headers' && <HeadersView headers={attributes.headers} />}
        {tab === 'mime' && <MimeView attributes={attributes} />}
        {tab === 'attachments' && <AttachmentsView attachments={attributes.body_structure.attachments ?? []} />}
        {tab === 'rules' && <RulesView diagnostics={attributes.match_diagnostics} hasRules={hasRules} />}
      </div>
    </div>
  )
}

function MailPreview({ preview, loading, onLoad }: {
  preview: Awaited<ReturnType<typeof getMailMessage>>['data']['attributes']['preview']
  loading: boolean
  onLoad: () => void
}) {
  const [mode, setMode] = useState<'text' | 'html'>(preview.text ? 'text' : 'html')
  if (!preview.available) {
    return (
      <div className="flex flex-col items-center gap-3 py-12 text-center">
        <p className="text-sm text-[var(--text-secondary)]">这封邮件目前只有索引信息，正文尚未下载。</p>
        <Button variant="secondary" disabled={loading} onClick={onLoad}>
          <CloudArrowDown aria-hidden className={`size-4 ${loading ? 'animate-pulse' : ''}`} />
          {loading ? '正在读取…' : '读取邮件内容'}
        </Button>
      </div>
    )
  }
  const html = preview.html ? isolatedHtml(preview.html) : ''
  return (
    <div className="flex flex-col gap-3">
      {preview.text && preview.html && (
        <div className="self-start">
          <select aria-label="预览格式" className={CONTROL_COMPACT} value={mode} onChange={(event) => setMode(event.target.value as 'text' | 'html')}>
            <option value="text">纯文本</option>
            <option value="html">HTML</option>
          </select>
        </div>
      )}
      {mode === 'html' && html ? (
        <iframe
          title="邮件 HTML 预览"
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={html}
          className="h-[470px] w-full rounded-md border border-[var(--border-subtle)] bg-white"
        />
      ) : (
        <pre className="max-h-[500px] overflow-auto whitespace-pre-wrap break-words font-sans text-sm leading-6 text-[var(--text-primary)]">{preview.text || '没有纯文本正文'}</pre>
      )}
    </div>
  )
}

function HeadersView({ headers }: { headers: Awaited<ReturnType<typeof getMailMessage>>['data']['attributes']['headers'] }) {
  const normalized = Object.entries(headers.normalized ?? {})
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
        {normalized.map(([name, values]) => (
          <div key={name} className="contents">
            <dt className="truncate font-mono text-[var(--text-tertiary)]">{name}</dt>
            <dd className="min-w-0 break-words text-[var(--text-primary)]">{values.join(', ')}</dd>
          </div>
        ))}
      </dl>
      <pre className="max-h-[360px] overflow-auto rounded-md bg-[var(--surface-0)] p-3 font-mono text-[11px] leading-5 whitespace-pre-wrap break-all text-[var(--text-secondary)]">{headers.raw || '没有原始 Header'}</pre>
    </div>
  )
}

function MimeView({ attributes }: { attributes: Awaited<ReturnType<typeof getMailMessage>>['data']['attributes'] }) {
  const attachments = attributes.body_structure.attachments ?? []
  return (
    <ul className="space-y-2 text-sm text-[var(--text-primary)]">
      <li className="rounded-md border border-[var(--border-subtle)] px-3 py-2">message/rfc822</li>
      {attributes.body_structure.has_text && <li className="ml-5 rounded-md border border-[var(--border-subtle)] px-3 py-2">text/plain</li>}
      {attributes.body_structure.has_html && <li className="ml-5 rounded-md border border-[var(--border-subtle)] px-3 py-2">text/html</li>}
      {attachments.map((attachment) => (
        <li key={`${attachment.filename}:${attachment.size}`} className="ml-5 flex items-center justify-between gap-3 rounded-md border border-[var(--border-subtle)] px-3 py-2">
          <span className="truncate">{attachment.filename}</span>
          <span className="shrink-0 font-mono text-xs text-[var(--text-tertiary)]">{attachment.mime}</span>
        </li>
      ))}
    </ul>
  )
}

function AttachmentsView({ attachments }: { attachments: Array<{ filename: string; mime: string; size: number }> }) {
  if (attachments.length === 0) return <p className="py-10 text-center text-sm text-[var(--text-secondary)]">没有附件</p>
  return (
    <div className="divide-y divide-[var(--border-subtle)] rounded-md border border-[var(--border-subtle)]">
      {attachments.map((attachment) => (
        <div key={`${attachment.filename}:${attachment.size}`} className="flex items-center gap-3 px-3 py-3">
          <Paperclip aria-hidden className="size-4 shrink-0 text-[var(--text-tertiary)]" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-[var(--text-primary)]">{attachment.filename}</p>
            <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">{attachment.mime} · {formatBytes(attachment.size)}</p>
          </div>
        </div>
      ))}
    </div>
  )
}

function RulesView({ diagnostics, hasRules }: { diagnostics: MailDiagnostic[]; hasRules: boolean }) {
  if (diagnostics.length === 0) return (
    <p className="py-10 text-center text-sm text-[var(--text-secondary)]">
      {hasRules ? '没有启用且已发布的规则参与本次归类。' : '尚未创建邮件规则，所以这封邮件显示为“未归类”。请在下方创建规则并绑定解析流程。'}
    </p>
  )
  return (
    <div className="space-y-3">
      {diagnostics.map((rule) => (
        <div key={`${rule.rule_id}:${rule.version}`} className="rounded-md border border-[var(--border-subtle)] px-3 py-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-[var(--text-primary)]">{rule.rule_name} · v{rule.version}</p>
            {rule.diagnostic.matched ? <CheckCircle aria-label="命中" className="size-4 text-[var(--done)]" /> : <XCircle aria-label="未命中" className="size-4 text-[var(--text-tertiary)]" />}
          </div>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">{rule.diagnostic.reason}</p>
          {rule.diagnostic.children && (
            <ul className="mt-2 space-y-1 border-l border-[var(--border-subtle)] pl-3 text-xs text-[var(--text-secondary)]">
              {rule.diagnostic.children.map((child, index) => <li key={`${child.kind}:${index}`}>{child.matched ? '通过' : '未通过'} · {child.reason}</li>)}
            </ul>
          )}
        </div>
      ))}
    </div>
  )
}

function RuleEditor({
  rules,
  loading,
  error,
  form,
  testResult,
  testScope,
  parserFlows,
  parserFlowsLoading,
  currentMessageId,
  onFormChange,
  onSelect,
  onNew,
  onTestResult,
  onTestScope,
}: {
  rules: MailRule[]
  loading: boolean
  error: Error | null
  form: RuleForm
  testResult: Awaited<ReturnType<typeof testMailRule>>['data'] | null
  testScope: 'current' | 'all' | null
  parserFlows: Awaited<ReturnType<typeof getParserFlows>>['data']
  parserFlowsLoading: boolean
  currentMessageId: string | null
  onFormChange: (form: RuleForm) => void
  onSelect: (rule: MailRule) => void
  onNew: () => void
  onTestResult: (result: Awaited<ReturnType<typeof testMailRule>>['data']) => void
  onTestScope: (scope: 'current' | 'all' | null) => void
}) {
  const queryClient = useQueryClient()
  const input = useMemo(() => formToInput(form), [form])
  const validation = validateRuleForm(form)
  const saveMutation = useMutation({
    mutationFn: () => form.id ? updateMailRule(form.id, input) : createMailRule(input),
    onSuccess: (response) => {
      void queryClient.invalidateQueries({ queryKey: ['mail-rules'] })
      onSelect(response.data)
      showToast({ kind: 'success', message: '规则草稿已保存' })
    },
    onError: mutationError('规则保存失败'),
  })
  const testMutation = useMutation({
    mutationFn: (scope: 'current' | 'all') => testMailRule({
      conditions: input.conditions,
      ...(scope === 'current' && currentMessageId ? { message_ids: [Number(currentMessageId)] } : {}),
      limit: scope === 'current' && currentMessageId ? 1 : 500,
    }),
    onSuccess: (response, scope) => {
      onTestScope(scope)
      onTestResult(response.data)
    },
    onError: mutationError('规则测试失败'),
  })
  const publishMutation = useMutation({
    mutationFn: async () => {
      const saved = await updateMailRule(form.id as string, input)
      const response = await publishMailRule(saved.data.id)
      const rerouted = currentMessageId ? await rerouteMailMessage(currentMessageId) : null
      return { response, rerouted }
    },
    onSuccess: ({ response, rerouted }) => {
      void queryClient.invalidateQueries({ queryKey: ['mail-rules'] })
      void queryClient.invalidateQueries({ queryKey: ['mail-messages'] })
      if (rerouted) queryClient.setQueryData(['mail-message', rerouted.data.id], rerouted)
      onSelect(response.data)
      showToast({ kind: 'success', message: currentMessageId ? `规则 v${response.data.attributes.current_version} 已发布，当前邮件已重新归类` : `规则 v${response.data.attributes.current_version} 已发布` })
    },
    onError: mutationError('规则发布失败'),
  })
  const publishValidation = validation ?? (!form.parserFlowId ? '发布前必须选择解析流程' : null)

  function updateCondition(key: number, patch: Partial<EditableCondition>) {
    onFormChange({ ...form, conditions: form.conditions.map((condition) => condition.key === key ? { ...condition, ...patch } : condition) })
  }

  return (
    <section className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface-1)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="shrink-0 text-sm font-semibold text-[var(--text-primary)]">邮件规则</h2>
          <select
            aria-label="选择邮件规则"
            className={`${CONTROL_COMPACT} min-w-[180px]`}
            value={form.id ?? ''}
            disabled={loading || Boolean(error)}
            onChange={(event) => {
              const rule = rules.find((item) => item.id === event.target.value)
              if (rule) onSelect(rule)
            }}
          >
            <option value="">新规则</option>
            {rules.map((rule) => <option key={rule.id} value={rule.id}>{rule.attributes.name} {rule.attributes.current_version ? `· v${rule.attributes.current_version}` : '· 草稿'}</option>)}
          </select>
          <IconButton label="新建规则" onClick={onNew}><Plus aria-hidden className="size-4" /></IconButton>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" disabled={Boolean(validation) || testMutation.isPending} onClick={() => testMutation.mutate(currentMessageId ? 'current' : 'all')}>
            <Play aria-hidden className="size-4" />{testMutation.isPending ? '测试中…' : currentMessageId ? '测试当前邮件' : '测试全部邮件'}
          </Button>
          {currentMessageId && (
            <Button variant="secondary" disabled={Boolean(validation) || testMutation.isPending} onClick={() => testMutation.mutate('all')}>
              <Play aria-hidden className="size-4" />测试全部邮件
            </Button>
          )}
          <Button variant="secondary" disabled={!form.safelyEditable || Boolean(validation) || saveMutation.isPending} onClick={() => saveMutation.mutate()}>
            <FloppyDisk aria-hidden className="size-4" />{saveMutation.isPending ? '保存中…' : '保存草稿'}
          </Button>
          <Button variant="primary" disabled={!form.safelyEditable || !form.id || Boolean(publishValidation) || publishMutation.isPending} title={publishValidation ?? undefined} onClick={() => publishMutation.mutate()}>
            <RocketLaunch aria-hidden className="size-4" />{publishMutation.isPending ? '发布中…' : '发布'}
          </Button>
        </div>
      </div>
      {error ? (
        <InlineError message="规则列表加载失败" error={error} />
      ) : (
        <div className="grid gap-5 p-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(260px,0.65fr)]">
          <div className="min-w-0 space-y-4">
            {!form.safelyEditable && (
              <InlineError message="这条规则包含当前表单无法无损编辑的附件数量、否定或嵌套条件。为避免丢失条件，请通过 API/CLI 编辑，或新建一条规则。" />
            )}
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(180px,1fr)_minmax(140px,0.55fr)_minmax(190px,0.75fr)_110px_auto]">
              <Field label="规则名称"><Input value={form.name} onChange={(event) => onFormChange({ ...form, name: event.target.value })} /></Field>
              <Field label="渠道标识"><Input className="font-mono" placeholder="citic" value={form.channelKey} onChange={(event) => onFormChange({ ...form, channelKey: event.target.value })} /></Field>
              <Field label="解析流程">
                <select
                  aria-label="解析流程"
                  className={CONTROL_COMPACT}
                  value={form.parserFlowId}
                  disabled={parserFlowsLoading}
                  onChange={(event) => {
                    const flow = parserFlows.find((item) => item.id === event.target.value)
                    onFormChange({
                      ...form,
                      parserFlowId: event.target.value,
                      ...(flow?.attributes.channel_key ? { channelKey: flow.attributes.channel_key } : {}),
                    })
                  }}
                >
                  <option value="">只归类，不解析</option>
                  {parserFlows.map((flow) => (
                    <option key={flow.id} value={flow.id}>{flow.attributes.name} · v{flow.attributes.current_version}</option>
                  ))}
                </select>
              </Field>
              <Field label="优先级"><Input type="number" min={0} max={10000} value={form.position} onChange={(event) => onFormChange({ ...form, position: Number(event.target.value) })} /></Field>
              <label className="flex items-end gap-2 pb-2 text-sm text-[var(--text-primary)]"><input type="checkbox" className="accent-[var(--brand)]" checked={form.enabled} onChange={(event) => onFormChange({ ...form, enabled: event.target.checked })} />启用</label>
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                <span>满足</span>
                <select aria-label="条件组合方式" className={CONTROL_COMPACT} value={form.group} onChange={(event) => onFormChange({ ...form, group: event.target.value as RuleGroup })}>
                  <option value="all">全部条件</option>
                  <option value="any">任一条件</option>
                </select>
              </div>
              <Button variant="ghost" size="xs" onClick={() => onFormChange({ ...form, conditions: [...form.conditions, emptyCondition()] })}><Plus aria-hidden className="size-3.5" />添加条件</Button>
            </div>
            <div className="space-y-2">
              {form.conditions.map((condition) => (
                <div key={condition.key} className="grid items-start gap-2 rounded-md bg-[var(--surface-0)] p-2 sm:grid-cols-[150px_110px_minmax(150px,1fr)_28px]">
                  <select aria-label="条件字段" className={CONTROL_COMPACT} value={condition.field} onChange={(event) => updateCondition(condition.key, { field: event.target.value as MailTextField, operator: 'contains' })}>
                    {FIELD_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                  <select aria-label="匹配方式" className={CONTROL_COMPACT} value={condition.operator} onChange={(event) => updateCondition(condition.key, { operator: event.target.value as MailTextOperator })}>
                    {condition.field === 'from' || condition.field === 'to' ? <option value="domain">域名是</option> : null}
                    {OPERATOR_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                  <div className={`grid gap-2 ${condition.field === 'header' ? 'sm:grid-cols-[120px_minmax(0,1fr)]' : ''}`}>
                    {condition.field === 'header' && <input aria-label="Header 名" className={CONTROL_COMPACT} placeholder="List-ID" value={condition.headerName} onChange={(event) => updateCondition(condition.key, { headerName: event.target.value })} />}
                    <input aria-label="条件值" className={CONTROL_COMPACT} value={condition.value} onChange={(event) => updateCondition(condition.key, { value: event.target.value })} />
                  </div>
                  <IconButton label="删除条件" variant="ghost-danger" disabled={form.conditions.length === 1} onClick={() => onFormChange({ ...form, conditions: form.conditions.filter((item) => item.key !== condition.key) })}><Trash aria-hidden className="size-4" /></IconButton>
                </div>
              ))}
            </div>
            {validation && <p className="text-xs text-[var(--danger)]">{validation}</p>}
          </div>
          <div className="min-w-0 border-t border-[var(--border-subtle)] pt-4 xl:border-t-0 xl:border-l xl:pt-0 xl:pl-5">
            <h3 className="text-xs font-semibold text-[var(--text-secondary)]">测试结果</h3>
            {testResult ? (
              <div className="mt-3 space-y-3">
                <p className="text-xs text-[var(--text-tertiary)]">{testScope === 'current' ? '当前邮件' : '全部索引邮件'}</p>
                <p className="text-2xl font-semibold tabular-nums text-[var(--text-primary)]">{testResult.matched}<span className="ml-1 text-xs font-normal text-[var(--text-secondary)]">/ {testResult.tested} 封</span></p>
                <ul className="max-h-48 space-y-1 overflow-y-auto text-xs text-[var(--text-secondary)]">
                  {testResult.samples.map((sample) => <li key={sample.id} className="truncate">{sample.subject || sample.from_address || `邮件 ${sample.id}`}</li>)}
                </ul>
              </div>
            ) : (
              <p className="mt-3 text-sm text-[var(--text-tertiary)]">尚未运行</p>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

function ruleToForm(rule: MailRule): RuleForm {
  const draft = rule.attributes.draft.conditions
  const root = draft.type === 'all' || draft.type === 'any' ? draft : { type: 'all' as const, conditions: [draft] }
  const conditions = root.conditions.flatMap((condition) => {
    if (condition.type !== 'text') return []
    return [{
      key: conditionKey++,
      field: condition.field,
      operator: condition.operator,
      value: condition.value,
      headerName: condition.header_name ?? '',
    }]
  })
  return {
    id: rule.id,
    name: rule.attributes.name,
    enabled: rule.attributes.enabled,
    position: rule.attributes.position,
    channelKey: rule.attributes.draft.channel_key,
    parserFlowId: rule.attributes.draft.parser_flow_id ?? '',
    group: root.type,
    conditions: conditions.length > 0 ? conditions : [emptyCondition()],
    safelyEditable: draft.type === 'text' || (
      (draft.type === 'all' || draft.type === 'any')
      && root.conditions.length > 0
      && root.conditions.every((condition) => condition.type === 'text')
    ),
  }
}

function formToInput(form: RuleForm): MailRuleInput {
  const conditions: MailRuleCondition[] = form.conditions.map((condition) => ({
    type: 'text',
    field: condition.field,
    operator: condition.operator,
    value: condition.value.trim(),
    ...(condition.field === 'header' ? { header_name: condition.headerName.trim() } : {}),
  }))
  return {
    name: form.name.trim(),
    enabled: form.enabled,
    position: form.position,
    channel_key: form.channelKey.trim(),
    parser_flow_id: form.parserFlowId ? Number(form.parserFlowId) : null,
    conditions: { type: form.group, conditions },
  }
}

function validateRuleForm(form: RuleForm): string | null {
  if (!form.safelyEditable) return '当前表单不能安全编辑这条复杂规则'
  if (!form.name.trim()) return '请填写规则名称'
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(form.channelKey.trim())) return '渠道标识只能使用小写字母、数字、中划线和下划线'
  if (!Number.isInteger(form.position) || form.position < 0 || form.position > 10000) return '优先级需在 0 到 10000 之间'
  for (const condition of form.conditions) {
    if (!condition.value.trim()) return '每个条件都需要填写值'
    if (condition.field === 'header' && !/^[A-Za-z0-9-]{1,80}$/.test(condition.headerName.trim())) return 'Header 名格式不正确'
    if (condition.operator === 'domain' && condition.field !== 'from' && condition.field !== 'to') return '域名匹配只适用于发件人或收件人'
  }
  return null
}

function mutationError(fallback: string) {
  return (error: Error) => showToast({
    kind: 'error',
    message: error instanceof AbeiApiError ? error.message : fallback,
    duration: 6000,
  })
}

function isolatedHtml(html: string): string {
  const policy = "default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; font-src data:"
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><style>body{font:14px/1.55 system-ui,sans-serif;color:#16181c;margin:16px;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%;border-collapse:collapse}td,th{padding:4px;border:1px solid #dfe2e6}</style></head><body>${html}</body></html>`
}

function classificationLabel(value: MailClassification): string {
  return ({ unclassified: '未归类', matched: '已匹配', ignored: '已忽略', error: '有错误' })[value]
}

function syncRunLabel(status: string, stage: string, kind: string): string {
  if (status === 'queued') return '等待同步'
  if (status === 'running') {
    if (stage === 'connect') return '正在连接邮箱'
    return kind === 'rescan' ? '正在扫描历史邮件' : '正在读取新邮件'
  }
  if (status === 'succeeded') return kind === 'rescan' ? '上次历史扫描完成' : '上次同步完成'
  if (status === 'failed') return kind === 'rescan' ? '上次历史扫描失败' : '上次同步失败'
  return '同步已取消'
}

function numericProgress(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function defaultRescanInput(): MailboxRescanInput {
  const to = new Date()
  const from = new Date(to)
  from.setDate(from.getDate() - 30)
  return { from: localIsoDate(from), to: localIsoDate(to), limit: 500 }
}

function localIsoDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function rescanKey(input: MailboxRescanInput): string {
  return `${input.from}:${input.to}:${input.limit}`
}

function validateRescanInput(input: MailboxRescanInput): string | null {
  if (!input.from || !input.to) return '请选择开始和结束日期。'
  if (input.from > input.to) return '结束日期不能早于开始日期。'
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) return '本轮上限必须在 1 到 500 之间。'
  const days = (Date.parse(`${input.to}T00:00:00Z`) - Date.parse(`${input.from}T00:00:00Z`)) / 86_400_000
  if (!Number.isFinite(days)) return '日期格式不正确。'
  if (days > 180) return '历史扫描最长 180 天。'
  return null
}

function shortDate(value: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(date)
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / 1024 / 1024).toFixed(1)} MiB`
}
