import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  CalendarBlank,
  CheckCircle,
  CloudArrowDown,
  DownloadSimple,
  EnvelopeOpen,
  FloppyDisk,
  Gear,
  Lightning,
  Paperclip,
  Play,
  Plus,
  PushPinSimple,
  RocketLaunch,
  Trash,
  XCircle,
} from '@phosphor-icons/react'
import {
  applyMailRule,
  getMailRuleApplyStatus,
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
  rollbackMailRule,
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
  type MailRuleApplyRun,
  type MailRuleCondition,
  type MailRuleInput,
  type MailTextField,
  type MailTextOperator,
} from '../../api/mail'
import { getParserFlows } from '../../api/parser'
import { AbeiApiError, isEndpointMissing } from '../../api/client'
import { ConfirmDialog } from '../../components/abei/ConfirmDialog'
import { EmptyState } from '../../components/abei/EmptyState'
import { ErrorState, InlineError } from '../../components/abei/ErrorState'
import { Modal } from '../../components/abei/Modal'
import { ProgressBar } from '../../components/abei/ProgressBar'
import { StatusChip } from '../../components/abei/StatusChip'
import { Button, IconButton } from '../../components/ui/Button'
import { CONTROL_COMPACT, Field, Input, Select } from '../../components/ui/Field'
import { Tabs } from '../../components/ui/Tabs'
import { formatDateTime } from '../../lib/format'
import { showToast } from '../../store/toastStore'
import { MailboxSettingsDialog } from '../mailbox/MailboxSettingsDialog'
import { ProcessingSummaryPanel } from './ProcessingSummaryPanel'

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
  /**
   * 这条规则的条件能不能用下面那个表单无损地表达。
   *
   * 否定、嵌套、附件数量这些条件表单画不出来。此前 false 就意味着保存、发布、测试全部禁用，
   * 规则被永久锁死——连「先停用它」都做不到。现在 false 只是不让改条件本体，
   * 名称/启用/优先级照常能改，靠的是把原始条件原样留在 rawConditions 里回传。
   */
  safelyEditable: boolean
  /** 服务端发来的草稿条件原文。表单画不出来时，保存和发布回传的就是它。 */
  rawConditions: MailRuleCondition
  /** 已发布的版本号，没发布过是 null。回滚按钮要用它判断有没有上一版可退。 */
  currentVersion: number | null
}

/** 规则测试一次最多扫多少封。服务端和界面用的是同一个数，改要一起改。 */
const TEST_LIMIT = 500

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
    rawConditions: { type: 'all', conditions: [] },
    currentVersion: null,
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
  /** 规则编辑器展开没有。默认收起——这一页是拿来读邮件的。 */
  const [ruleOpen, setRuleOpen] = useState(false)
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

  /**
   * 未归类总数，单独取一次。
   *
   * 顶栏原先把「上次同步这一轮新发现的未归类数」写成「未归类 0」，而下面的列表满屏都是未归类——
   * 同一个词在同一屏里指两件事。现在同步那格只说这一轮的增量，未归类总数从列表接口的 total 取，
   * 和左边列表是同一个口径。
   */
  const unclassifiedQuery = useQuery({
    queryKey: ['mail-messages-unclassified-total'],
    queryFn: () => getMailMessages({ classification: 'unclassified', limit: 1 }),
    staleTime: 15_000,
  })
  const unclassifiedTotal = unclassifiedQuery.data?.meta?.pagination?.total ?? null

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
    void queryClient.invalidateQueries({ queryKey: ['mail-messages-unclassified-total'] })
  }, [completedRunKey, queryClient])

  /**
   * 同步期间把邮件列表也跟着刷。
   *
   * 原先只在整轮结束后刷一次：历史扫描要跑好几分钟，这期间邮件一封封进库了，
   * 界面却纹丝不动，看着就像卡死。4 秒一次足够看出在动，又不会把列表刷得没法点。
   */
  useEffect(() => {
    if (!syncRunning) return
    const timer = setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: ['mail-messages'] })
      void queryClient.invalidateQueries({ queryKey: ['mail-messages-unclassified-total'] })
    }, 4_000)
    return () => clearInterval(timer)
  }, [syncRunning, queryClient])

  // 只在没选中过时兜底选第一封。不再因为「当前筛选里没有这封」就把选中项弹掉——
  // 规则测试结果点进来的那封往往不在当前筛选里，弹掉就等于点了没反应。
  useEffect(() => {
    if (selectedId === null && messages.length > 0) setSelectedId(messages[0].id)
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
    // 自动缓存是打开邮件时后台顺手做的，用户没点过它。失败了弹红条只会让人以为自己弄坏了什么，
    // 而且这个错还会盖住他真正在做的事。静默失败，详情区那句「原文未缓存」和按钮就是出口。
    onError: (error, input) => {
      if (input.silent) return
      mutationError('邮件重新缓存失败')(error)
    },
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
      void navigate({ to: '/parser', search: { sample: response.data.id } })
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

  /** 收起 / 展开两种摆法共用同一份 props，别在两处各写一遍 */
  const ruleEditorProps = {
    rules,
    loading: rulesQuery.isLoading,
    error: rulesQuery.error,
    form: ruleForm,
    testResult,
    parserFlows,
    parserFlowsLoading: parserFlowsQuery.isLoading,
    currentMessageId: selectedId,
    onFormChange: (next: RuleForm) => { setRuleForm(next); setTestResult(null) },
    onSelect: selectRule,
    onNew: startRule,
    onTestResult: setTestResult,
    testScope,
    onTestScope: setTestScope,
    onLocateMessage: (id: string) => {
      // 筛选清空，这封才可能出现在左边列表里；详情区无论如何都能直接打开它。
      setClassification('')
      setSearch('')
      setMessageOffset(0)
      setSelectedId(id)
      setDetailTab('preview')
    },
  }

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col gap-3">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-[var(--text-primary)]">邮件工作台</h1>
          <div className="mt-1 flex max-w-2xl flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--text-secondary)]">
            {activeRun && (
              <>
                <span className="shrink-0">
                  {syncRunLabel(activeRun.status, activeRun.stage, activeRun.kind)}：检查 {activeRun.counts.scanned}{activeTotal > 0 ? ` / ${activeTotal}` : ''} 封 · 新匹配 {activeRun.counts.matched} 封
                </span>
                {activeRun.status === 'running' && activeTotal > 0 && (
                  <ProgressBar pct={activePercent} label="邮件同步进度" />
                )}
              </>
            )}
            {/* 这一格是全库口径，和左边列表同源；上面那格只说本轮同步的增量。两件事必须分开写。 */}
            {unclassifiedTotal !== null && (
              <button
                type="button"
                className="shrink-0 rounded-md px-1.5 py-0.5 hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                onClick={() => { setClassification('unclassified'); setMessageOffset(0) }}
              >
                未归类共 {unclassifiedTotal} 封
              </button>
            )}
          </div>
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

      <ProcessingSummaryPanel />

      {/*
        规则编辑器默认收成一条工具条。
        这一页的主体是「读邮件」——列表 + 详情；规则是读完之后偶尔改一次的配置。
        把整个编辑器常驻在列表上方的结果是：改规则时要上下滚，滚到规则那儿就看不见
        那封触发你改规则的邮件，对照不了。现在它平时只占一行，展开后作为右侧分栏
        和邮件详情同屏。
      */}
      {!ruleOpen && (
        <RuleEditor
          {...ruleEditorProps}
          open={false}
          onOpenChange={setRuleOpen}
        />
      )}

      <div
        className={`grid min-h-0 flex-1 overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[var(--surface-1)] ${
          ruleOpen
            ? 'lg:grid-cols-[minmax(260px,0.7fr)_minmax(0,1.3fr)] xl:grid-cols-[minmax(240px,0.6fr)_minmax(0,1.1fr)_minmax(340px,0.9fr)]'
            : 'lg:grid-cols-[minmax(300px,0.78fr)_minmax(0,1.5fr)]'
        }`}
      >
        <section className="flex min-h-0 flex-col border-b border-[var(--border-subtle)] lg:border-r lg:border-b-0">
          <div className="grid grid-cols-[minmax(0,1fr)_130px] gap-2 border-b border-[var(--border-subtle)] p-3">
            <input
              aria-label="搜索邮件"
              className={CONTROL_COMPACT}
              placeholder="发件人、主题、附件名"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <Select compact aria-label="归类状态" value={classification} onChange={(event) => setClassification(event.target.value as '' | MailClassification)}
            >
              {CLASSIFICATIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </Select>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
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

        {ruleOpen && (
          <aside className="flex min-h-0 min-w-0 flex-col overflow-y-auto border-t border-[var(--border-subtle)] xl:border-t-0 xl:border-l">
            <RuleEditor {...ruleEditorProps} open onOpenChange={setRuleOpen} />
          </aside>
        )}
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
      <MailboxSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
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
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-[var(--border-subtle)] px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="break-words text-base font-semibold text-[var(--text-primary)]">{attributes.subject || '无主题'}</h2>
            <p className="mt-1 truncate text-xs text-[var(--text-secondary)]">{attributes.from_address || '未知发件人'}</p>
            <p className="mt-0.5 text-[11px] text-[var(--text-tertiary)]">{attributes.received_at ? formatDateTime(attributes.received_at) : '时间未知'}</p>
            {attributes.content_state !== 'cached' && (
              <p className="mt-1 flex items-center gap-1.5 text-[11px] text-[var(--text-tertiary)]">
                原文未缓存
                <Button variant="ghost" size="xs" disabled={caching} onClick={onCache}>
                  {caching ? '缓存中…' : '重新缓存'}
                </Button>
              </p>
            )}
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
          <Select compact aria-label="预览格式" value={mode} onChange={(event) => setMode(event.target.value as 'text' | 'html')}>
            <option value="text">纯文本</option>
            <option value="html">HTML</option>
          </Select>
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
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words font-sans text-sm leading-6 text-[var(--text-primary)]">{preview.text || '没有纯文本正文'}</pre>
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
      <pre className="max-h-[24rem] overflow-auto rounded-md bg-[var(--surface-0)] p-3 font-mono text-[11px] leading-5 whitespace-pre-wrap break-all text-[var(--text-secondary)]">{headers.raw || '没有原始 Header'}</pre>
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
  onLocateMessage,
  open,
  onOpenChange,
}: {
  /** 收起时只出一条工具条；展开时才是完整的编辑器 */
  open: boolean
  onOpenChange: (open: boolean) => void
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
  onLocateMessage: (id: string) => void
}) {
  const queryClient = useQueryClient()
  const input = useMemo(() => formToInput(form), [form])
  const validation = validateRuleForm(form)
  const [applyScope, setApplyScope] = useState<'unclassified' | 'all'>('unclassified')
  const [applyRun, setApplyRun] = useState<MailRuleApplyRun | null>(null)
  const startedRunRef = useRef<string | null>(null)
  const reportedRunRef = useRef<string | null>(null)
  const [applyUnavailable, setApplyUnavailable] = useState(false)
  const [confirmApply, setConfirmApply] = useState(false)
  const [confirmRollback, setConfirmRollback] = useState(false)
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
      limit: scope === 'current' && currentMessageId ? 1 : TEST_LIMIT,
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
      return publishMailRule(saved.data.id)
    },
    onSuccess: (response) => {
      void queryClient.invalidateQueries({ queryKey: ['mail-rules'] })
      void queryClient.invalidateQueries({ queryKey: ['mail-messages'] })
      onSelect(response.data)
      showToast({
        kind: 'success',
        message: `规则 v${response.data.attributes.current_version} 已发布。用「应用到全部命中邮件」把已有邮件一起重新归类。`,
        duration: 7000,
      })
    },
    onError: mutationError('规则发布失败'),
  })

  /**
   * 批量重归类（B2）。
   *
   * 此前发布规则只会顺手把「当前打开的那一封」重归类，244 封未匹配邮件得逐封点 243 次。
   * 这里一次把规则命中的全打过去，解析过的由服务端排重解析——不然改完规则，
   * 旧的错解析结果还在账单文档里挂着。
   *
   * 服务端现在只开一条后台任务就返回，所以这里拿到的是任务的初始状态，进度靠下面轮询。
   */
  const applyMutation = useMutation({
    mutationFn: () => applyMailRule(form.id as string, { scope: applyScope, limit: TEST_LIMIT }),
    onSuccess: (response) => {
      setConfirmApply(false)
      setApplyRun(response.data)
      startedRunRef.current = response.data.run_id
      showToast({ kind: 'success', message: '批量重归类已开始，进度会在下面更新', duration: 5000 })
    },
    onError: (error) => {
      setConfirmApply(false)
      // 服务端还没发这个端点是预期内的（两边分开发布），说清楚就行，别当成失败刷红条。
      if (isEndpointMissing(error)) {
        setApplyUnavailable(true)
        return
      }
      mutationError('批量重归类失败')(error)
    },
  })

  /**
   * 任务进度轮询。
   *
   * 只在任务真的在跑时开定时器；`interrupted` 和 `failed` 都是终态，停下来别空转。
   * 页面重开也能接上——状态在服务端库里，不在这个组件的内存里。
   */
  const applyStatusQuery = useQuery({
    queryKey: ['mail-rule-apply-status', form.id],
    queryFn: () => getMailRuleApplyStatus(form.id as string),
    enabled: form.id !== null && form.currentVersion !== null && !applyUnavailable,
    refetchInterval: (query) => (query.state.data?.data.state === 'running' ? 1500 : false),
  })

  const applyStatusError = applyStatusQuery.error
  useEffect(() => {
    // 服务端还没上这个端点时静默降级，跟 apply 本身一个待遇。
    if (applyStatusError && isEndpointMissing(applyStatusError)) setApplyUnavailable(true)
  }, [applyStatusError])

  const applyStatus = applyStatusQuery.data?.data
  useEffect(() => {
    if (!applyStatus) return
    setApplyRun(applyStatus)
    if (applyStatus.run_id === null) return
    if (applyStatus.state === 'running') {
      // 页面重开时接上一条还在跑的任务，跑完了照样给个交代。
      startedRunRef.current = applyStatus.run_id
      return
    }
    // 只报这次会话看着它跑的那条，且一条只报一次——否则一进页面就为上回的旧任务弹提示。
    if (startedRunRef.current !== applyStatus.run_id) return
    if (reportedRunRef.current === applyStatus.run_id) return
    reportedRunRef.current = applyStatus.run_id
    void queryClient.invalidateQueries({ queryKey: ['mail-messages'] })
    void queryClient.invalidateQueries({ queryKey: ['mail-message'] })
    void queryClient.invalidateQueries({ queryKey: ['mail-messages-unclassified-total'] })
    void queryClient.invalidateQueries({ queryKey: ['bill-documents'] })
    if (applyStatus.state === 'succeeded') {
      showToast({
        kind: 'success',
        message: `已重归类 ${applyStatus.rerouted} 封，触发重解析 ${applyStatus.reparse_jobs} 封`,
        duration: 7000,
      })
      return
    }
    showToast({
      kind: 'error',
      message: applyStatus.state === 'interrupted'
        ? `批量重归类中断了，${applyStatus.matched} 封里处理了 ${applyStatus.rerouted} 封，剩下的再点一次继续`
        : `批量重归类失败：${applyStatus.error ?? '服务端没说原因'}`,
      duration: 8000,
    })
  }, [applyStatus, queryClient])

  /** 回滚（G3）。服务端要的是目标版本号，退的是「上一个发布版本」。 */
  const rollbackTarget = form.currentVersion !== null && form.currentVersion > 1 ? form.currentVersion - 1 : null
  const rollbackMutation = useMutation({
    mutationFn: () => rollbackMailRule(form.id as string, rollbackTarget as number),
    onSuccess: (response) => {
      setConfirmRollback(false)
      void queryClient.invalidateQueries({ queryKey: ['mail-rules'] })
      void queryClient.invalidateQueries({ queryKey: ['mail-messages'] })
      onSelect(response.data)
      showToast({
        kind: 'success',
        message: `已按版本 ${rollbackTarget} 的条件发布 v${response.data.attributes.current_version}`,
        duration: 7000,
      })
    },
    onError: (error) => {
      setConfirmRollback(false)
      mutationError('规则回滚失败')(error)
    },
  })

  const publishValidation = validation ?? (!form.parserFlowId ? '发布前必须选择解析流程' : null)
  const published = form.id !== null && form.currentVersion !== null

  function updateCondition(key: number, patch: Partial<EditableCondition>) {
    onFormChange({ ...form, conditions: form.conditions.map((condition) => condition.key === key ? { ...condition, ...patch } : condition) })
  }

  const ruleSelect = (
    <Select compact aria-label="选择邮件规则" className="min-w-[180px]" value={form.id ?? ''} disabled={loading || Boolean(error)} onChange={(event) => {
        const rule = rules.find((item) => item.id === event.target.value)
        if (rule) onSelect(rule)
      }}
    >
      <option value="">新规则</option>
      {rules.map((rule) => <option key={rule.id} value={rule.id}>{rule.attributes.name} {rule.attributes.current_version ? `· v${rule.attributes.current_version}` : '· 草稿'}</option>)}
    </Select>
  )

  /**
   * 收起态：一行工具条。当前规则名、发布状态、一个「编辑规则」。
   * 平时它就该是这么大——这一页的主体是邮件，不是规则。
   */
  if (!open) {
    return (
      <section className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-1)] px-3 py-2">
        <h2 className="shrink-0 text-[13px] font-semibold text-[var(--text-primary)]">邮件规则</h2>
        {ruleSelect}
        <StatusChip
          label={published ? `已发布 v${form.currentVersion}` : form.id ? '草稿未发布' : '还没建规则'}
          kind={published ? 'ok' : 'warn'}
        />
        {error && <InlineError message="规则列表加载失败" error={error} />}
        <span className="ml-auto flex items-center gap-2">
          <IconButton label="新建规则" onClick={() => { onNew(); onOpenChange(true) }}>
            <Plus aria-hidden className="size-4" />
          </IconButton>
          <Button variant="secondary" size="sm" aria-expanded={false} onClick={() => onOpenChange(true)}>
            编辑规则
          </Button>
        </span>
      </section>
    )
  }

  return (
    <section className="flex min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h2 className="shrink-0 text-[13px] font-semibold text-[var(--text-primary)]">邮件规则</h2>
          {ruleSelect}
          <IconButton label="新建规则" onClick={onNew}><Plus aria-hidden className="size-4" /></IconButton>
          <Button variant="ghost" size="sm" aria-expanded onClick={() => onOpenChange(false)}>
            收起
          </Button>
        </div>
        {/* 两颗按钮固定在这儿，各说各的范围。原先是一颗按钮按「有没有选中邮件」变文案，
            再条件渲染出第二颗同名的——同一屏出现两个「测试全部邮件」，点哪个都对但看着像 bug。 */}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={!currentMessageId || Boolean(validation) || testMutation.isPending}
            title={currentMessageId ? undefined : '先在下面选中一封邮件'}
            onClick={() => testMutation.mutate('current')}
          >
            <Play aria-hidden className="size-4" />测试当前邮件
          </Button>
          <Button variant="secondary" size="sm" disabled={Boolean(validation) || testMutation.isPending} onClick={() => testMutation.mutate('all')}>
            <Play aria-hidden className="size-4" />{testMutation.isPending ? '测试中…' : '测试全部邮件'}
          </Button>
          <Button variant="secondary" size="sm" disabled={Boolean(validation) || saveMutation.isPending} onClick={() => saveMutation.mutate()}>
            <FloppyDisk aria-hidden className="size-4" />{saveMutation.isPending ? '保存中…' : '保存草稿'}
          </Button>
          <Button variant="primary" size="sm" disabled={!form.id || Boolean(publishValidation) || publishMutation.isPending} title={publishValidation ?? undefined} onClick={() => publishMutation.mutate()}>
            <RocketLaunch aria-hidden className="size-4" />{publishMutation.isPending ? '发布中…' : '发布'}
          </Button>
          {rollbackTarget !== null && (
            <Button
              variant="secondary"
              size="sm"
              disabled={rollbackMutation.isPending}
              onClick={() => setConfirmRollback(true)}
            >
              <ArrowCounterClockwise aria-hidden className="size-4" />回滚到 v{rollbackTarget}
            </Button>
          )}
        </div>
      </div>
      {error ? (
        <InlineError message="规则列表加载失败" error={error} />
      ) : (
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-3">
          <div className="min-w-0 space-y-4">
            {applyUnavailable && (
              <InlineError message="服务端尚未更新：批量重归类接口还没上线。服务端发布后这个按钮就能用，单封重归类不受影响。" />
            )}
            {published && (
              <ApplyBar
                scope={applyScope}
                onScopeChange={setApplyScope}
                pending={applyMutation.isPending}
                disabled={applyUnavailable}
                run={applyRun}
                onApply={() => setConfirmApply(true)}
              />
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="规则名称"><Input value={form.name} onChange={(event) => onFormChange({ ...form, name: event.target.value })} /></Field>
              <Field label="渠道标识"><Input className="font-mono" placeholder="citic" value={form.channelKey} onChange={(event) => onFormChange({ ...form, channelKey: event.target.value })} /></Field>
              <Field label="解析流程">
                <Select compact aria-label="解析流程" value={form.parserFlowId} disabled={parserFlowsLoading} onChange={(event) => {
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
                </Select>
              </Field>
              <Field label="优先级"><Input type="number" min={0} max={10000} value={form.position} onChange={(event) => onFormChange({ ...form, position: Number(event.target.value) })} /></Field>
              <label className="flex items-end gap-2 pb-2 text-sm text-[var(--text-primary)]"><input type="checkbox" className="accent-[var(--brand)]" checked={form.enabled} onChange={(event) => onFormChange({ ...form, enabled: event.target.checked })} />启用</label>
            </div>
            {!form.safelyEditable ? (
              <RuleSourceView conditions={form.rawConditions} />
            ) : (
              <>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                <span>满足</span>
                <Select compact aria-label="条件组合方式" value={form.group} onChange={(event) => onFormChange({ ...form, group: event.target.value as RuleGroup })}>
                  <option value="all">全部条件</option>
                  <option value="any">任一条件</option>
                </Select>
              </div>
              <Button variant="ghost" size="xs" onClick={() => onFormChange({ ...form, conditions: [...form.conditions, emptyCondition()] })}><Plus aria-hidden className="size-3.5" />添加条件</Button>
            </div>
            <div className="space-y-2">
              {form.conditions.map((condition) => (
                <div key={condition.key} className="grid items-start gap-2 rounded-md bg-[var(--surface-0)] p-2 sm:grid-cols-[130px_100px_minmax(120px,1fr)_28px]">
                  <Select compact aria-label="条件字段" value={condition.field} onChange={(event) => updateCondition(condition.key, { field: event.target.value as MailTextField, operator: 'contains' })}>
                    {FIELD_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </Select>
                  <Select compact aria-label="匹配方式" value={condition.operator} onChange={(event) => updateCondition(condition.key, { operator: event.target.value as MailTextOperator })}>
                    {condition.field === 'from' || condition.field === 'to' ? <option value="domain">域名是</option> : null}
                    {OPERATOR_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </Select>
                  <div className={`grid gap-2 ${condition.field === 'header' ? 'sm:grid-cols-[120px_minmax(0,1fr)]' : ''}`}>
                    {condition.field === 'header' && <input aria-label="Header 名" className={CONTROL_COMPACT} placeholder="List-ID" value={condition.headerName} onChange={(event) => updateCondition(condition.key, { headerName: event.target.value })} />}
                    <input aria-label="条件值" className={CONTROL_COMPACT} value={condition.value} onChange={(event) => updateCondition(condition.key, { value: event.target.value })} />
                  </div>
                  <IconButton label="删除条件" variant="ghost-danger" disabled={form.conditions.length === 1} onClick={() => onFormChange({ ...form, conditions: form.conditions.filter((item) => item.key !== condition.key) })}><Trash aria-hidden className="size-4" /></IconButton>
                </div>
              ))}
            </div>
              </>
            )}
            {validation && <p className="text-xs text-[var(--danger)]">{validation}</p>}
          </div>
          <div className="min-w-0 border-t border-[var(--border-subtle)] pt-4">
            <h3 className="text-xs font-semibold text-[var(--text-secondary)]">测试结果</h3>
            {testResult ? (
              <div className="mt-3 space-y-3">
                <p className="text-xs text-[var(--text-tertiary)]">{testScope === 'current' ? '当前邮件' : '全部索引邮件'}</p>
                <p className="text-2xl font-semibold tabular-nums text-[var(--text-primary)]">
                  匹配 {testResult.matched}
                  <span className="ml-1 text-xs font-normal text-[var(--text-secondary)]">/ 已测 {testResult.tested} 封</span>
                </p>
                {/* 服务端一次最多扫 500 封。不说这句，「匹配 12 / 已测 500」会被当成全库只有 500 封。 */}
                {testScope === 'all' && (
                  <p className="text-[11px] text-[var(--text-tertiary)]">
                    只测了最近 {TEST_LIMIT} 封。要覆盖全部邮件，发布后用「应用到全部命中邮件」。
                  </p>
                )}
                <ul className="max-h-48 space-y-1 overflow-y-auto text-xs">
                  {testResult.samples.map((sample) => (
                    <li key={sample.id}>
                      <button
                        type="button"
                        className="w-full truncate rounded-md px-1.5 py-1 text-left text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                        onClick={() => onLocateMessage(sample.id)}
                      >
                        {sample.subject || sample.from_address || `邮件 ${sample.id}`}
                      </button>
                    </li>
                  ))}
                </ul>
                {testResult.samples.length > 0 && (
                  <p className="text-[11px] text-[var(--text-tertiary)]">点一条可以打开那封邮件。</p>
                )}
              </div>
            ) : (
              <p className="mt-3 text-sm text-[var(--text-tertiary)]">尚未运行</p>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmApply}
        title="把这条规则应用到已有邮件"
        confirmLabel="应用到全部命中邮件"
        pendingLabel="应用中…"
        tone="primary"
        pending={applyMutation.isPending}
        onConfirm={() => applyMutation.mutate()}
        onClose={() => setConfirmApply(false)}
      >
        <p>
          会把「{form.name || '这条规则'}」命中的{applyScope === 'unclassified' ? '未归类' : '全部'}邮件重新归类，
          一次最多处理 {TEST_LIMIT} 封。
        </p>
        <p>已经解析过的邮件会重新解析，生成新一版账单行；已入账的行不会被撤回。</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmRollback}
        title={`回滚到版本 ${rollbackTarget}`}
        confirmLabel="回滚"
        pendingLabel="回滚中…"
        pending={rollbackMutation.isPending}
        onConfirm={() => rollbackMutation.mutate()}
        onClose={() => setConfirmRollback(false)}
      >
        <p>
          会把版本 {rollbackTarget} 的条件重新发布一次，成为新的当前版本，草稿也跟着改回去。
        </p>
        <p>历史版本一条都不会删。已经归类过的邮件不会自动变——要改用「应用到全部命中邮件」。</p>
      </ConfirmDialog>
    </section>
  )
}

/**
 * 批量应用条。
 *
 * 放在规则编辑区顶部而不是按钮排里：它作用于「已经在库里的邮件」，和保存/发布这种
 * 只动规则本身的操作不是一回事，混在一排容易顺手点下去。
 */
function ApplyBar({
  scope,
  onScopeChange,
  pending,
  disabled,
  run,
  onApply,
}: {
  scope: 'unclassified' | 'all'
  onScopeChange: (scope: 'unclassified' | 'all') => void
  pending: boolean
  disabled: boolean
  run: MailRuleApplyRun | null
  onApply: () => void
}) {
  const running = run?.state === 'running'
  const busy = pending || running
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md bg-[var(--surface-0)] px-3 py-2">
      <span className="text-xs text-[var(--text-secondary)]">把这条已发布的规则应用到</span>
      <Select compact aria-label="批量应用范围" value={scope} disabled={busy} onChange={(event) => onScopeChange(event.target.value as 'unclassified' | 'all')}
      >
        <option value="unclassified">未归类的邮件</option>
        <option value="all">全部邮件（含已归到别处的）</option>
      </Select>
      <Button variant="primary" size="sm" disabled={busy || disabled} onClick={onApply}>
        <Lightning aria-hidden className="size-4" />{busy ? '应用中…' : '应用到全部命中邮件'}
      </Button>
      {run && run.state !== 'idle' && (
        <span className="text-xs text-[var(--text-secondary)]">{applyRunText(run)}</span>
      )}
    </div>
  )
}

/**
 * 任务进度写成一句话。
 *
 * 跑的时候报「已处理 N/M」而不是只报最终数字：一批几百封要跑几分钟，
 * 中间什么都不显示的话，人分不清是在跑还是又挂了。
 */
function applyRunText(run: MailRuleApplyRun): string {
  const handled = run.rerouted + run.failed
  const failedText = run.failed > 0 ? `，${run.failed} 封没处理成` : ''
  switch (run.state) {
    case 'running':
      return `命中 ${run.matched} 封，已处理 ${handled}/${run.matched} 封${failedText}。`
    case 'interrupted':
      return `任务中断在 ${handled}/${run.matched} 封${failedText}，再点一次接着跑。`
    case 'failed':
      return `任务失败：${run.error ?? '服务端没说原因'}`
    default:
      return `命中 ${run.matched} 封，已重归类 ${run.rerouted} 封，触发重解析 ${run.reparse_jobs} 封${failedText}。`
  }
}

/**
 * 复杂规则的源码兜底（G2）。
 *
 * 表单画不出否定和嵌套，但「看不见」不该等于「动不了」：以前这类规则连改个名字、
 * 临时停用都做不到。条件在这里只读展示，上面的名称、优先级、启用照常可改可存。
 */
function RuleSourceView({ conditions }: { conditions: MailRuleCondition }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold text-[var(--text-secondary)]">条件（源码模式，只读）</h3>
        <StatusChip label="表单画不出这条规则" kind="warn" />
      </div>
      <p className="text-xs text-[var(--text-secondary)]">
        这条规则用了否定、嵌套或附件数量条件，表单改不了它们。名称、渠道、解析流程、优先级和启用状态照常可以改并保存，
        条件本体要改请走 API 或 CLI。
      </p>
      <pre className="max-h-64 overflow-auto rounded-md bg-[var(--surface-0)] p-3 font-mono text-[11px] leading-5 whitespace-pre-wrap break-all text-[var(--text-secondary)]">
        {JSON.stringify(conditions, null, 2)}
      </pre>
    </div>
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
    rawConditions: draft,
    currentVersion: rule.attributes.current_version,
  }
}

/**
 * 表单 → 提交体。
 *
 * 条件本体的来源看 `safelyEditable`：表单画得出来就用表单里那几行；画不出来（否定、嵌套、
 * 附件数量）就原样回传服务端发来的那份。后者是复杂规则还能改名称、改优先级、能停用的前提——
 * 少了这一步，PATCH 会把没画出来的条件抹成空。
 */
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
    conditions: form.safelyEditable ? { type: form.group, conditions } : form.rawConditions,
  }
}

function validateRuleForm(form: RuleForm): string | null {
  if (!form.name.trim()) return '请填写规则名称'
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(form.channelKey.trim())) return '渠道标识只能使用小写字母、数字、中划线和下划线'
  if (!Number.isInteger(form.position) || form.position < 0 || form.position > 10000) return '优先级需在 0 到 10000 之间'
  // 复杂规则的条件不在表单里，表单那几行是空占位，校验它们没有意义。
  if (!form.safelyEditable) return null
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
