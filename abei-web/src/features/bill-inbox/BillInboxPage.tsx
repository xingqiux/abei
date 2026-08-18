import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { ArrowsClockwise, CaretRight, Gear, Sparkle } from '@phosphor-icons/react'
import {
  invalidateBillInbox,
  useBillInboxSummary,
  useBillRows,
  useBillInboxSettings,
  useBillRowCounts,
  flattenBillRows,
  BILL_ROWS_PAGE_SIZE,
  useBillTasks,
  useUndoBillImport,
  useDismissBillRows,
  useImportBillRows,
  useReconcileBillImportAttempt,
  useRestoreBillRows,
  useRetryBillImportAttempt,
  useSyncBillInbox,
} from '../../api/queries'
import { useBillInboxSelection } from './useBillInboxSelection'
import { AssistantApiError, runAutofill } from '../../api/assistant'
import type { BillImportResponse, BillQueueRow, BillRowGroup } from '../../api/schemas'
import { EmptyState } from '../../components/abei/EmptyState'
import { Skeleton } from '../../components/abei/Skeleton'
import { InlineError } from '../../components/abei/ErrorState'
import { Button, IconButton } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { SegmentedControl } from '../../components/ui/SegmentedControl'
import { showToast } from '../../store/toastStore'
import { AbeiApiError } from '../../api/client'
import { BillInboxSettingsDialog } from './BillInboxSettingsDialog'
import { ImportConfirmDialog } from './ImportConfirmDialog'
import { InboxOnboardingCard } from './InboxOnboardingCard'
import { PendingClearCard } from './PendingClearCard'
import { ConfirmDialog } from '../../components/abei/ConfirmDialog'
import { QueueRow } from './QueueRow'
import { PairCard } from './PairCard'
import { StuckBanner } from './PipelineBar'
import { ChannelAccountBanner } from './ChannelAccountBanner'
import { ChannelBar } from './ChannelBar'
import {
  buildPairEntries,
  buildSourceGroups,
  channelDisplayName,
  groupRowsByImportBatch,
  pairScopeOf,
  type ImportBatchGroup,
  DONE_VIEW_LABELS,
  DONE_VIEWS,
  doneViewOf,
  formatSignedMoney,
  groupAttentionRows,
  groupRowsByDay,
  INBOX_TAB_LABELS,
  INBOX_TABS,
  inboxTabOf,
  isAiSuggested,
  isRowSelectable,
  needsAutofill,
  PENDING_SECTION_IDS,
  relativeDayLabel,
  relativeTimeLabel,
  syncResultFeedback,
  type CurrencyTotal,
  type DoneView,
  type InboxTab,
  type PendingSection,
  type SourceGroup,
} from './billInboxHelpers'
import * as copy from './copy'
import { formatAmount, formatDateTime, formatMonthDay } from '../../lib/format'

/**
 * 超过这个数才弹干跑确认；以下直接执行 + 撤销窗口（设计稿 02 §4）。
 *
 * 只看笔数会错配：一封日账单常见解析出 9 笔，日常几乎从不弹确认，21 笔却弹。
 * 所以再加一条——只要选中的行里有带问题的，不管几笔都先给干跑清单看。
 */
const DIRECT_IMPORT_LIMIT = 20

/** 撤销那条 toast 留久一点：8 秒里没点，就当人是认下了 */
const UNDO_TOAST_DURATION = 8000

/** 请求同步后追问几次、隔多久：够覆盖「排队记录晚一两百毫秒落库」这段 */
const SYNC_POLL_ATTEMPTS = 8
const SYNC_POLL_INTERVAL = 900

/** 「已经在生成建议」时替用户盯着刷新的节奏 */
const AUTOFILL_POLL_ATTEMPTS = 6
const AUTOFILL_POLL_INTERVAL = 2500

/** 「这次同步是我请求的」记在会话里，刷新页面也还认得（见 requestedSyncAt） */
const SYNC_REQUEST_KEY = 'abei.bill-inbox.sync-requested-at'

function readRequestedSync(): string | null {
  try {
    return window.sessionStorage.getItem(SYNC_REQUEST_KEY)
  } catch {
    // 隐私模式 / 存储被禁：退回「不记得」，行为等同刷新前的老实现
    return null
  }
}

function writeRequestedSync(value: string | null): void {
  try {
    if (value === null) window.sessionStorage.removeItem(SYNC_REQUEST_KEY)
    else window.sessionStorage.setItem(SYNC_REQUEST_KEY, value)
  } catch {
    // 同上，写不进去也不该让点击报错
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { window.setTimeout(resolve, ms) })
}

/**
 * 账单收件箱。
 *
 * 信息架构是两层：一级只回答「还有没有活」（待处理 / 已完成），二级才回答
 * 「是哪一类活」（待入账 / 待确认）。四个并列 tab 的老结构等于把
 * 同一个问题拆成四个数字让人自己合并，而首屏还常常落在空的那一个上。
 *
 * 顶部只留两行：header 和一条管道条。原来是五层（header / 处理摘要卡 /
 * 未匹配横幅 / 工作量卡 / sticky 筛选），列表被压到 400px 以下——
 * 一个以「一屏扫十几笔」为前提的列表，屏幕却只剩不到半屏。
 */
export function BillInboxPage() {
  const search = useSearch({ from: '/bill-inbox' })
  const navigate = useNavigate({ from: '/bill-inbox' })
  const source = search.source
  const taskFilter = search.task ?? null
  const tab: InboxTab = inboxTabOf(search)
  const doneView: DoneView = doneViewOf(search)

  const queryClient = useQueryClient()
  const summaryQuery = useBillInboxSummary()
  const syncMutation = useSyncBillInbox()
  const dismissMutation = useDismissBillRows()
  const restoreMutation = useRestoreBillRows()
  const importMutation = useImportBillRows()
  const reconcileMutation = useReconcileBillImportAttempt()
  const retryImportMutation = useRetryBillImportAttempt()
  const undoImportMutation = useUndoBillImport()
  /**
   * 「我刚请求过一次同步」这件事写在 sessionStorage 上而不是 ref 上：
   * 同步要跑几十秒，中途刷新页面（或从别的页面转一圈回来）时 ref 就没了，
   * 完成回调再也不会触发——列表停在同步前的样子，人只能自己再点一次。
   */
  const [requestedSyncAt, setRequestedSyncAt] = useState<string | null>(() => readRequestedSync())

  const [settingsOpen, setSettingsOpen] = useState(false)
  /** 行内拆分弹窗开着没有：快捷键要整套停用，得知道这件事 */
  const [splitDialogOpen, setSplitDialogOpen] = useState(false)
  /** 勾选 / 光标 / 展开 / 编辑：一起变的东西收在一个 reducer 里 */
  const [selection, dispatchSelection] = useBillInboxSelection()
  const { selected, expandedId, editingId, cursorIndex } = selection
  const [dryRun, setDryRun] = useState<BillImportResponse | null>(null)
  /** 正在等确认的「撤回这批」。撤回会从账本删交易，不能点一下就走。 */
  const [undoBatch, setUndoBatch] = useState<ImportBatchGroup | null>(null)
  const [confirmRowIds, setConfirmRowIds] = useState<string[]>([])
  const [autofillRunning, setAutofillRunning] = useState(false)
  /** 正在等请求回来的行。禁用只落在这些行上，不牵连整屏。 */
  const [pendingRowIds, setPendingRowIds] = useState<ReadonlySet<string>>(() => new Set())
  const pageRef = useRef<HTMLDivElement | null>(null)
  const stickyRef = useRef<HTMLDivElement | null>(null)

  /** tab 和渠道条上的数字都从 summary 里取，不再各自发请求 */
  const counts = useBillRowCounts(summaryQuery.data)

  /**
   * 待处理层同时要两组数据：待入账的和待确认的。
   *
   * 分成两个查询而不是一个：两组的分页、空态、加载态互不牵连，
   * 「待确认」那 200 笔翻到第 3 页时，「待入账」不该跟着重拉。
   */
  const pendingActive = tab === 'pending'
  const importableQuery = useBillRows('importable', { source, documentId: taskFilter, enabled: pendingActive })
  const attentionQuery = useBillRows('attention', { source, documentId: taskFilter, enabled: pendingActive })
  const doneQuery = useBillRows(doneView, { source, documentId: taskFilter, enabled: !pendingActive })

  // 来源面板要的是整箱邮件，故意不跟着当前渠道过滤走：面板本身就是换渠道的地方，
  // 跟着过滤会把「换一个渠道看看」这条路自己堵死。
  const tasksQuery = useBillTasks()
  const billTasks = useMemo(() => tasksQuery.data?.data ?? [], [tasksQuery.data])

  /**
   * 兜底：服务端还没上 document_id 参数时（会把整组行原样返回），仍然在前端筛一道，
   * 不然「只看这封邮件」会变成「什么都没筛」。服务端认了这个参数之后这里恒等于原数组。
   */
  const filterByTask = useCallback(
    (list: BillQueueRow[]) => (taskFilter === null
      ? list
      : list.filter((row) => String(row.attributes.bill_task_id) === taskFilter)),
    [taskFilter],
  )

  const importable = useRowSlice(importableQuery.data?.pages, filterByTask)
  const attention = useRowSlice(attentionQuery.data?.pages, filterByTask)
  const done = useRowSlice(doneQuery.data?.pages, filterByTask)

  /** 屏幕上此刻能看到的全部行。勾选、光标、账户映射候选都以它为准。 */
  const rows = useMemo(
    () => (pendingActive ? [...importable.rows, ...attention.rows] : done.rows),
    [pendingActive, importable.rows, attention.rows, done.rows],
  )

  const rowSections = useMemo(() => groupAttentionRows(attention.rows), [attention.rows])
  /**
   * 「疑似同一笔」那一节折成的条目。算一次就够：节头的计数、节说明的措辞、
   * 列表本身用的是同一份条目，各算各的必然会出现「节头说 3 对、下面摆着 4 张卡」。
   */
  const pairEntries = useMemo(() => {
    const section = rowSections.find((item) => item.kind === 'pairing_suggested')
    return section ? buildPairEntries(section.rows) : []
  }, [rowSections])

  const channelName = useCallback(
    (key: string) => channelDisplayName(key, summaryQuery.data?.channels.find((channel) => channel.key === key)?.name),
    [summaryQuery.data],
  )

  const sourceGroups = useMemo<SourceGroup[]>(
    () => buildSourceGroups(billTasks, summaryQuery.data?.channels ?? []),
    [billTasks, summaryQuery.data],
  )

  /** 渠道 chip 上的笔数：跟着当前一级 tab 走，数字全部来自 summary */
  const channelKeys = useMemo(() => sourceGroups.map((group) => group.key), [sourceGroups])
  const tabCountFor = useCallback(
    (which: InboxTab, channel?: string) => (which === 'pending'
      ? counts.countFor('importable', channel) + counts.countFor('attention', channel)
      : counts.countFor('imported', channel) + counts.countFor('dismissed', channel)),
    [counts],
  )
  const channelCounts = useMemo(() => {
    const out: Record<string, number | undefined> = {}
    for (const key of channelKeys) out[key] = tabCountFor(tab, key)
    return out
  }, [channelKeys, tabCountFor, tab])

  const dayGroups = useMemo(() => groupRowsByDay(importable.rows), [importable.rows])
  const doneDayGroups = useMemo(() => groupRowsByDay(done.rows), [done.rows])
  /**
   * 已入账按批次分，不按日期分：日期回答不了「我刚才那一下入了哪几笔」——
   * 同一天可以入好几次，一次也可以横跨好几天的流水。已忽略照旧按日期。
   */
  const doneBatchGroups = useMemo(() => groupRowsByImportBatch(done.rows), [done.rows])
  const today = new Date().toLocaleDateString('sv-SE')

  /** j/k 走的是屏幕上看到的顺序：分了小节就按小节来；没放出来的行不算 */
  const cursorRows = useMemo(() => {
    if (!pendingActive) return done.rows
    return [
      ...importable.rows,
      ...rowSections.flatMap((section) => section.rows),
    ]
  }, [pendingActive, done.rows, importable.rows, rowSections])

  /** 光标行在 cursorRows 里的下标：每行各扫一遍数组就是 O(n²)，先建一张表 */
  const cursorIndexById = useMemo(() => {
    const index = new Map<string, number>()
    cursorRows.forEach((row, position) => index.set(row.id, position))
    return index
  }, [cursorRows])

  const selectable = pendingActive
  const selectableIds = useMemo(
    () => (selectable ? rows.filter(isRowSelectable).map((row) => row.id) : []),
    [rows, selectable],
  )
  /** 「待入账」这一节里能入的那些。主按钮无勾选时作用的就是它。 */
  const importableIds = useMemo(
    () => importable.rows.filter(isRowSelectable).map((row) => row.id),
    [importable.rows],
  )
  const allImportableSelected = importableIds.length > 0 && importableIds.every((id) => selected.has(id))
  const someImportableSelected = importableIds.some((id) => selected.has(id))
  const aiSuggestedCount = useMemo(() => rows.filter(isAiSuggested).length, [rows])
  const autofillPending = useMemo(() => rows.some(needsAutofill), [rows])
  const mailboxSync = summaryQuery.data?.mailbox_sync
  const mailboxSyncActive = mailboxSync?.status === 'queued' || mailboxSync?.status === 'running'
  const syncBusy = syncMutation.isPending || mailboxSyncActive
  /**
   * 上次同步在什么时候。在跑的时候不说这句——一句「上次同步 12 分钟前」
   * 摆在转着的图标旁边，读起来像是这一趟已经完了。
   */
  const lastSyncHint = mailboxSyncActive ? null : relativeTimeLabel(mailboxSync?.finished_at)

  // 空箱引导：邮箱连没连、有没有解析出过流水，决定卡在哪一步。
  const settingsQuery = useBillInboxSettings()
  const mailbox = settingsQuery.data?.data.attributes
  const mailboxReady = !!mailbox
    && mailbox.email.trim() !== ''
    && (mailbox.has_password || mailbox.google_connected)
  const hasAnyRows = ['importable', 'attention', 'dismissed', 'imported']
    .some((group) => counts.countFor(group as BillRowGroup) > 0)
  /**
   * 设置读不回来时不能走空箱引导：那会把一个早就连好邮箱的人请去「连接邮箱」，
   * 他照做一遍还是失败，因为坏的是接口不是他的邮箱。改成明说加载失败 + 重试。
   */
  const settingsBroken = settingsQuery.isError
  const inboxIsBlank = !hasAnyRows && !settingsBroken && taskFilter === null && source === undefined

  /**
   * 待处理两节都空。
   *
   * 加载中和加载失败都不算清完：那时候的 0 是「还不知道」，拿它庆祝一遍，
   * 等数据回来又冒出四十笔，用户会以为自己看错了。两节都得确实读回来才作数。
   */
  const pendingCleared = pendingActive
    && !importableQuery.isLoading && !importableQuery.isError
    && !attentionQuery.isLoading && !attentionQuery.isError
    && importable.rows.length === 0
    && attention.rows.length === 0

  // 换 tab / 换渠道 / 换邮件后，之前选中的行已经不在屏幕上了，留着选中状态只会误伤。
  useEffect(() => {
    dispatchSelection({ type: 'reset' })
  }, [source, tab, doneView, taskFilter, dispatchSelection])

  /**
   * 两层粘性要对齐：控制条钉在滚动区顶端，日期分组头贴着它的下沿。
   *
   * 两个数都得量：条子的高度会随换行变化；而浏览器把吸附线放在滚动容器的
   * 内容盒上 —— 也就是被 main 的上内边距推低了一截，不把这一截让回去，
   * 条子和视口顶端之间会露出一条缝，列表正好从缝里穿过去。
   * 变量写在整页的根节点上：分组头在另一棵子树里，CSS 变量只往下传，不往旁边传。
   */
  useEffect(() => {
    const bar = stickyRef.current
    const page = pageRef.current
    if (!bar || !page || typeof ResizeObserver === 'undefined') return
    const scroller = bar.closest('main')
    const pad = scroller ? Number.parseFloat(getComputedStyle(scroller).paddingTop) || 0 : 0
    const write = () => {
      page.style.setProperty('--stick-pad', `${pad}px`)
      page.style.setProperty('--stick-h', `${Math.round(bar.offsetHeight)}px`)
    }
    write()
    const observer = new ResizeObserver(write)
    observer.observe(bar)
    return () => observer.disconnect()
  }, [])

  /**
   * 旧链接 ?view=attention 落进来时滚到「待确认」那一块。
   *
   * 只滚不筛：待处理层永远两块都渲染，把 attention 落成筛选就等于把
   * 「待入账」藏起来，和两层叙事自相矛盾。滚完就把锚从 URL 上摘掉，
   * 否则页面每次重渲染都会把人拽回那一块。
   */
  const anchor: PendingSection | undefined = search.section
  useEffect(() => {
    if (!anchor || !pendingActive) return
    document.getElementById(PENDING_SECTION_IDS[anchor])?.scrollIntoView({ block: 'start' })
    void navigate({ search: (prev) => ({ ...prev, section: undefined }), replace: true })
  }, [anchor, pendingActive, navigate])

  /**
   * 切一级 tab。写进 search 并一直留着，直链能复现。
   */
  function setTab(next: InboxTab) {
    void navigate({
      search: { source, task: taskFilter ?? undefined, tab: next === 'pending' ? undefined : next },
      replace: true,
    })
  }

  function setDoneView(next: DoneView) {
    void navigate({
      search: { source, task: taskFilter ?? undefined, tab: 'done', done: next === 'imported' ? undefined : next },
      replace: true,
    })
  }

  /** 当前 search 里除筛选之外的那部分，改渠道 / 改邮件时原样带上 */
  const layerSearch = useMemo(
    () => ({
      tab: tab === 'pending' ? undefined : ('done' as const),
      done: tab === 'done' && doneView === 'dismissed' ? ('dismissed' as const) : undefined,
    }),
    [tab, doneView],
  )

  /**
   * 换渠道要清掉邮件筛选：还钉在上一个渠道那封邮件上只会得到空列表。
   *
   * 反过来「选一封邮件」这个动作现在不在这一页做了——邮件清单搬去了二级页，
   * 那边点「看这封解析出的流水」时带着 ?task 回来，落地即是筛好的。
   */
  function setSourceFilter(next: string | null) {
    void navigate({ search: { ...layerSearch, source: next ?? undefined, task: undefined }, replace: true })
  }

  function clearFilters() {
    void navigate({ search: { ...layerSearch, source: undefined, task: undefined }, replace: true })
  }

  function toggleSelect(rowId: string, index: number, shift: boolean) {
    dispatchSelection({
      type: 'toggle',
      rowId,
      index,
      shift,
      selectableIds,
      orderedIds: cursorRows.map((row) => row.id),
    })
  }

  function toggleSelectAllImportable() {
    dispatchSelection({ type: 'selectAll', selectableIds: importableIds })
  }

  useEffect(() => {
    if (
      requestedSyncAt === null
      || mailboxSync?.requested_at !== requestedSyncAt
      || mailboxSync.status === 'queued'
      || mailboxSync.status === 'running'
    ) return

    setRequestedSyncAt(null)
    writeRequestedSync(null)
    invalidateBillInbox(queryClient)

    if (mailboxSync.status === 'succeeded' && mailboxSync.result) {
      const feedback = syncResultFeedback(mailboxSync.result)
      showToast({ ...feedback, duration: feedback.kind === 'error' ? 8000 : undefined })
      return
    }

    const feedback = mailboxSync.result ? syncResultFeedback(mailboxSync.result) : null
    showToast({
      kind: 'error',
      message: feedback?.kind === 'error'
        ? feedback.message
        : mailboxSync.error_message || '邮箱同步失败，请检查邮箱设置后重试',
      duration: 8000,
    })
  }, [mailboxSync, queryClient, requestedSyncAt])

  async function handleSync() {
    if (syncBusy) return
    try {
      const res = await syncMutation.mutateAsync({})
      const requestedAt = res.data.attributes.requested_at
      setRequestedSyncAt(requestedAt)
      writeRequestedSync(requestedAt)
      showToast({ kind: 'success', message: '已开始检查新邮件' })
      // 只 refetch 一次是不够的：那一趟常常早于「排队」落库，读回来还是 idle，
      // 于是轮询开关（refetchInterval 只在 queued/running 时打开）永远打不开，
      // 界面就此停住。这里主动追问几次，直到看见在跑或者确认它没跑起来。
      for (let attempt = 0; attempt < SYNC_POLL_ATTEMPTS; attempt += 1) {
        const next = await summaryQuery.refetch()
        const status = next.data?.mailbox_sync?.status
        if (status === 'queued' || status === 'running') return
        if (next.data?.mailbox_sync?.requested_at === requestedAt) return
        await sleep(SYNC_POLL_INTERVAL)
      }
    } catch (err) {
      showToast({
        kind: 'error',
        message: err instanceof AbeiApiError ? err.message : '同步邮件失败，请稍后重试',
        duration: 6000,
      })
    }
  }

  /** 当前这层在跑的那个查询：刷新、空态、加载态都问它 */
  const activeQuery = pendingActive ? importableQuery : doneQuery

  async function handleAutofill() {
    if (autofillRunning) return
    setAutofillRunning(true)
    try {
      const result = await runAutofill()
      showToast({
        kind: 'success',
        message: `已生成 ${result.rows} 笔填写建议（来自 ${result.tasks} 封邮件）`,
      })
      void activeQuery.refetch()
    } catch (err) {
      // 409 = 后台已经在跑。这不是出错，别拿红色吓人；但也不能只说一句
      // 「完成后刷新查看」就撒手——那等于让人自己去按 F5。这里替他盯着。
      if (err instanceof AssistantApiError && err.status === 409) {
        showToast({ kind: 'success', message: '已在生成建议，稍后自动刷新' })
        await pollAutofill()
        return
      }
      showToast({
        kind: 'error',
        message: err instanceof Error ? err.message : '生成建议失败，请稍后重试',
        duration: 6000,
      })
    } finally {
      setAutofillRunning(false)
    }
  }

  /** 后台已经在跑时，隔一会儿拉一次行列表，把建议接回来；拉够几次就收手 */
  async function pollAutofill() {
    for (let attempt = 0; attempt < AUTOFILL_POLL_ATTEMPTS; attempt += 1) {
      await sleep(AUTOFILL_POLL_INTERVAL)
      const next = await activeQuery.refetch()
      const { rows: refreshed } = flattenBillRows(next.data?.pages)
      if (refreshed.some(isAiSuggested)) {
        showToast({ kind: 'success', message: '建议已生成，已刷新列表' })
        return
      }
    }
  }

  /** 撤销的对象是行，不是交易组：交易删掉之后这些行要回到队列里等重新处理。 */
  function undoTargets(response: BillImportResponse): string[] {
    return Array.from(
      new Set(response.rows.filter((row) => row.action === 'imported').map((row) => String(row.row_id))),
    )
  }

  /**
   * 撤销走服务端：一次请求里先删账本里的交易，再把行放回 pending、把入账记录标成已撤销。
   * 以前这一步是浏览器直接删 Firefly 交易，abei 这边完全不知情——行一直停在
   * 「已入账」，永远不会回队列，「查看交易」还指向一笔已经不存在的交易。
   */
  async function undoImport(rowIds: string[]) {
    let undone = 0
    let failed = rowIds.length
    let detail = ''
    try {
      const res = await undoImportMutation.mutateAsync(rowIds)
      undone = res.data.summary.undone
      failed = res.data.summary.failed
      detail = res.data.rows.find((row) => row.outcome === 'failed')?.error ?? ''
    } catch (err) {
      detail = err instanceof AbeiApiError ? err.message : ''
    }
    // 撤销改的是收件箱的行与汇总，这些缓存得自己拉回来，否则撤销完队列里看不到这些行。
    invalidateBillInbox(queryClient)

    if (failed === 0) {
      showToast({ kind: 'success', message: `已撤销 ${undone} 笔交易` })
      return
    }
    showToast({
      kind: 'error',
      message: `已撤销 ${undone} 笔，${failed} 笔没撤回${detail ? `：${detail}` : ''}。剩下的可到交易页手动删除。`,
      duration: 8000,
    })
  }

  async function runImport(rowIds: string[]) {
    const res = await importMutation.mutateAsync({ rowIds, confirm: true })
    dispatchSelection({ type: 'clearSelection' })
    reportImportResult(res)
  }

  function reportImportResult(res: BillImportResponse) {
    const groupIds = undoTargets(res)
    const pending = [
      res.summary.uncertain > 0 ? `${res.summary.uncertain} 笔结果待核实` : null,
      res.summary.retryable > 0 ? `${res.summary.retryable} 笔可以重试` : null,
      res.summary.failed > 0 ? `${res.summary.failed} 笔没入上` : null,
      res.summary.skipped > 0 ? `${res.summary.skipped} 笔这次没动` : null,
    ].filter(Boolean)
    showToast({
      kind: pending.length === 0 ? 'success' : 'error',
      message: [`已入账 ${res.summary.imported} 笔`, ...pending].join('，'),
      duration: pending.length === 0 ? UNDO_TOAST_DURATION : 8000,
      // 操作类 toast 带一颗可点的撤销（05 §toast）：撤的就是刚入的这一批，
      // 和已完成层组头上那颗「撤回这批」走同一条路。
      action: groupIds.length > 0
        ? { label: copy.TOAST_UNDO, onClick: () => void undoImport(groupIds) }
        : undefined,
    })
  }

  /** 把这几行标成「正在处理」，请求结束再摘掉。摘的动作放 finally，失败也得摘。 */
  async function withRowsPending<T>(rowIds: string[], run: () => Promise<T>): Promise<T> {
    setPendingRowIds((current) => {
      const next = new Set(current)
      for (const id of rowIds) next.add(id)
      return next
    })
    try {
      return await run()
    } finally {
      setPendingRowIds((current) => {
        const next = new Set(current)
        for (const id of rowIds) next.delete(id)
        return next
      })
    }
  }

  async function handleReconcile(attemptId: string, rowId: string) {
    try {
      const result = await withRowsPending([rowId], () => reconcileMutation.mutateAsync(attemptId))
      if (result.data.status === 'reconciled' || result.data.status === 'succeeded') {
        showToast({ kind: 'success', message: '核实完成：账本里已经有这笔，归入已入账' })
      } else {
        showToast({ kind: 'success', message: '核实完成：账本里没有这笔，现在可以重试入账' })
      }
    } catch (error) {
      showToast({
        kind: 'error',
        message: error instanceof AbeiApiError ? error.message : '核实失败，请稍后重试',
        duration: 8000,
      })
    }
  }

  async function handleRetryImport(attemptId: string, rowId: string) {
    try {
      reportImportResult(await withRowsPending([rowId], () => retryImportMutation.mutateAsync(attemptId)))
    } catch (error) {
      showToast({
        kind: 'error',
        message: error instanceof AbeiApiError ? error.message : '重试入账没成功，请稍后再试',
        duration: 8000,
      })
    }
  }

  async function handleImport(rowIds: string[]) {
    if (rowIds.length === 0 || importMutation.isPending) return
    try {
      const chosen = new Set(rowIds)
      const risky = rows.some((row) => chosen.has(row.id) && (row.attributes.issues?.length ?? 0) > 0)
      if (rowIds.length <= DIRECT_IMPORT_LIMIT && !risky) {
        await runImport(rowIds)
        return
      }
      // 笔数多、或者里面有带问题的行，先给一份干跑清单：
      // 这个动作没法只撤销「其中错的那几笔」
      const preview = await importMutation.mutateAsync({ rowIds, confirm: false })
      setDryRun(preview)
      setConfirmRowIds(
        preview.rows
          // 「会自动新建账户」在预览里长得像跳过，确认后是真入账的一员，别落下。
          .filter((row) => row.action === 'would_import' || row.reason_code === 'channel_account_auto_create')
          .map((row) => row.row_id),
      )
    } catch (err) {
      showToast({
        kind: 'error',
        message: err instanceof AbeiApiError ? err.message : '入账失败，请重试',
        duration: 6000,
      })
    }
  }

  async function handleConfirmImport() {
    if (confirmRowIds.length === 0) return
    try {
      await runImport(confirmRowIds)
      setDryRun(null)
      setConfirmRowIds([])
    } catch (err) {
      showToast({
        kind: 'error',
        message: err instanceof AbeiApiError ? err.message : '入账失败，请重试',
        duration: 6000,
      })
    }
  }

  async function handleDismiss(rowIds: string[]) {
    if (rowIds.length === 0) return
    try {
      await withRowsPending(rowIds, () => dismissMutation.mutateAsync({ row_ids: rowIds }))
      dispatchSelection({ type: 'forget', rowIds })
      showToast({
        kind: 'success',
        message: `已忽略 ${rowIds.length} 笔`,
        duration: UNDO_TOAST_DURATION,
        action: { label: copy.TOAST_UNDO, onClick: () => void handleRestore(rowIds) },
      })
    } catch (err) {
      showToast({
        kind: 'error',
        message: err instanceof AbeiApiError ? err.message : '忽略失败，请重试',
        duration: 6000,
      })
    }
  }

  async function handleRestore(rowIds: string[]) {
    if (rowIds.length === 0) return
    try {
      await withRowsPending(rowIds, () => restoreMutation.mutateAsync(rowIds))
      // 不说「回到待入账」：落到哪个列表由服务端按行的状态重算，
      // 一笔账户还没对上的行恢复后会进待确认，说死了就是在骗人。
      showToast({
        kind: 'success',
        message: `已恢复 ${rowIds.length} 笔，按状态回到对应列表`,
      })
    } catch (err) {
      showToast({
        kind: 'error',
        message: err instanceof AbeiApiError ? err.message : '恢复失败，请重试',
        duration: 6000,
      })
    }
  }

  /**
   * 快捷键要用的那几个 handler 每次渲染都是新函数，直接进依赖数组会让监听器
   * 一秒装卸好几遍；放进 ref 里，effect 只依赖真正影响「装不装」的那几个值，
   * 触发时读到的又始终是最新的实现。
   */
  const keyActions = useRef({ handleDismiss, handleImport, toggleSelect })
  keyActions.current = { handleDismiss, handleImport, toggleSelect }

  /** 屏幕上有没有开着的弹窗。行内的拆分弹窗由 QueueRow 回报上来。 */
  const dialogOpen = dryRun !== null || settingsOpen || splitDialogOpen || undoBatch !== null
  const dismissPending = dismissMutation.isPending
  const importPending = importMutation.isPending

  /**
   * 键盘流：j/k 上下（两层都能用）、x 勾选、e 编辑、d 忽略、Enter 入账。
   *
   * 三条规矩：
   * 1）任何弹窗开着就整套停用 —— 干跑确认框开着时按 Enter，原来会绕过弹窗直接
   *    再发一次入账；按 d 则是把弹窗背后那一行悄悄忽略掉，屏幕上毫无反应。
   * 2）d 和 Enter 的作用域一致：有勾选就作用于勾选，没勾选才作用于光标那一行。
   *    原来 Enter 认勾选、d 只认光标行，同一套手势两种含义。
   * 3）请求在飞的时候不重复发。
   *
   * TODO(命令面板)：设计稿要求把这套快捷键也登记进 Cmd+K 的说明里，
   * 但 features/command-palette 归另一位负责，等那边开口子再接。
   */
  useEffect(() => {
    if (editingId || dialogOpen) return
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target
      if (target instanceof HTMLElement) {
        const tag = target.tagName.toLowerCase()
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable) return
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const list = cursorRows
      if (list.length === 0) return
      const index = Math.min(cursorIndex, list.length - 1)
      const row = list[index]
      if (!row) return

      // j/k 是「浏览」，已完成层一样要能翻
      if (event.key === 'j' || event.key === 'ArrowDown') {
        event.preventDefault()
        dispatchSelection({ type: 'cursor', index: Math.min(index + 1, list.length - 1) })
        return
      }
      if (event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault()
        dispatchSelection({ type: 'cursor', index: Math.max(index - 1, 0) })
        return
      }

      if (!selectable) return
      const scoped = selected.size > 0 ? Array.from(selected) : [row.id]

      if (event.key === 'x') {
        event.preventDefault()
        if (isRowSelectable(row)) keyActions.current.toggleSelect(row.id, index, false)
      } else if (event.key === 'e') {
        event.preventDefault()
        dispatchSelection({ type: 'edit', rowId: row.id })
      } else if (event.key === 'd') {
        event.preventDefault()
        if (dismissPending) return
        void keyActions.current.handleDismiss(scoped)
      } else if (event.key === 'Enter') {
        event.preventDefault()
        if (importPending) return
        void keyActions.current.handleImport(
          selected.size > 0 ? scoped : isRowSelectable(row) ? [row.id] : [],
        )
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // dispatchSelection 是 useReducer 给的，跨渲染稳定，列进来只是让 lint 闭嘴不改行为。
  }, [
    selectable,
    editingId,
    dialogOpen,
    dismissPending,
    importPending,
    cursorRows,
    cursorIndex,
    selected,
    dispatchSelection,
  ])

  useEffect(() => {
    const row = cursorRows[cursorIndex]
    if (!row) return
    document.getElementById(`bill-row-${row.id}`)?.scrollIntoView({ block: 'nearest' })
  }, [cursorIndex, cursorRows])

  const cursorRowId = cursorRows[cursorIndex]?.id ?? null
  const selectedCount = selected.size
  /**
   * 主操作只有一个位置：「待入账」节头上的那一颗。
   *
   * 无勾选时它作用于这一节全部，有勾选时改为作用于勾选，文案实时跟着变。
   * 原来卡片头和底部浮条各有一颗「入账 N 笔」，两颗的 N 还不一样
   * （一颗是可选中的全部，一颗是勾选数），同屏两个主按钮说的是两件事。
   */
  const primaryImportIds = selectedCount > 0 ? Array.from(selected) : importableIds
  const selectedTaskLabel = taskFilter === null
    ? null
    : sourceGroups.flatMap((group) => group.tasks).find((task) => task.id === taskFilter)?.attributes.summary ?? null

  function rowProps(row: BillQueueRow, mode: 'importable' | 'attention' | DoneView) {
    const index = cursorIndexById.get(row.id) ?? -1
    const attempt = row.attributes.import_attempt
    const rowSelectable = selectable && isRowSelectable(row)
    return {
      row,
      mode,
      onSplitDialogChange: setSplitDialogOpen,
      selectable: rowSelectable,
      selected: selected.has(row.id),
      onSelect: (shift: boolean) => toggleSelect(row.id, index, shift),
      focused: cursorRowId === row.id,
      expanded: expandedId === row.id,
      onToggleExpand: () =>
        dispatchSelection({ type: 'expand', rowId: expandedId === row.id ? null : row.id }),
      editing: editingId === row.id,
      onStartEdit: () => dispatchSelection({ type: 'edit', rowId: row.id }),
      onEndEdit: () => dispatchSelection({ type: 'edit', rowId: null }),
      onDismiss: selectable ? () => void handleDismiss([row.id]) : undefined,
      onRestore: mode === 'dismissed' ? () => void handleRestore([row.id]) : undefined,
      onReconcile: attempt?.status === 'uncertain'
        ? () => void handleReconcile(attempt.id, row.id)
        : undefined,
      onRetryImport: attempt?.status === 'retryable'
        ? () => void handleRetryImport(attempt.id, row.id)
        : undefined,
      // 「入账」只给自己就能入的行；卡在别的事情上的行主动作是那件事，不是入账
      onImport: mode === 'importable' && rowSelectable
        ? () => void handleImport([row.id])
        : undefined,
      // busy 按行算，不再一有请求就把整屏按钮全禁掉：忽略第 3 行的那一下，
      // 不该让第 40 行的「恢复」也变灰。
      busy: pendingRowIds.has(row.id),
    }
  }

  const filterNote = (taskFilter !== null || source !== undefined) && (
    <span className="flex items-center gap-1.5 text-[11.5px] text-[var(--text-secondary)]">
      {taskFilter !== null
        ? copy.filterNoteMail(selectedTaskLabel ?? copy.FILTER_NOTE_FALLBACK_MAIL)
        : copy.filterNoteChannel(channelName(source ?? ''))}
      <button
        type="button"
        onClick={clearFilters}
        className="text-[var(--brand-text)] underline-offset-2 hover:underline"
      >
        {copy.FILTER_CLEAR}
      </button>
    </span>
  )

  return (
    <div ref={pageRef} className="flex flex-col gap-5 pb-16">
      {/*
        页头收成两行：标题一行，「邮箱那头怎么样」一行。
        原来这里还压着一条完整的漏斗（收了 N 封 → 解析成 N 封 → 产出 N 笔），
        它和列表上的「待处理 N」是两个主数字，同屏摆着谁也说不清今天的活是哪个。
        漏斗整块搬去了二级页，这里只留一个入口。
      */}
      <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-lg font-semibold text-[var(--text-primary)]">{copy.PAGE_TITLE}</h1>
          <p className="text-[11.5px] text-[var(--text-tertiary)]">{copy.PAGE_SUBTITLE}</p>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px]">
          {/*
            同步不是日常动作：每 5 分钟自己跑一趟，手动只是「我现在就想看看」。
            人真正想知道的是「这一屏是不是最新的」，所以先说上次同步在什么时候。
          */}
          {lastSyncHint && (
            <span className="text-[var(--text-tertiary)]">{copy.lastSyncNote(lastSyncHint)}</span>
          )}
          <Button variant="ghost" size="xs" disabled={syncBusy} onClick={() => void handleSync()}>
            <ArrowsClockwise aria-hidden className={`size-4 ${syncBusy ? 'animate-spin' : ''}`} />
            {syncBusy ? copy.SYNC_BUTTON_BUSY : copy.SYNC_INLINE}
          </Button>
          <Link
            to="/bill-inbox/mail"
            className="flex items-center gap-0.5 rounded px-1.5 py-1 font-semibold text-[var(--brand-text)] underline-offset-2 hover:underline"
          >
            {copy.MAIL_PAGE_ENTRY}
            <CaretRight aria-hidden className="size-3.5" />
          </Link>
          {autofillPending && (
            <Button variant="ghost" size="xs" disabled={autofillRunning} onClick={() => void handleAutofill()}>
              <Sparkle aria-hidden className="size-4" />
              {autofillRunning ? copy.AUTOFILL_BUTTON_BUSY : copy.AUTOFILL_BUTTON_IDLE}
            </Button>
          )}
          <IconButton label={copy.MAILBOX_SETTINGS_BUTTON} onClick={() => setSettingsOpen(true)}>
            <Gear aria-hidden className="size-4" />
          </IconButton>
        </div>
      </header>

      {summaryQuery.isError && (
        <InlineError message={copy.SUMMARY_ERROR} error={summaryQuery.error} onRetry={() => void summaryQuery.refetch()} />
      )}

      {settingsBroken && (
        <InlineError
          message={copy.SETTINGS_ERROR}
          error={settingsQuery.error}
          onRetry={() => void settingsQuery.refetch()}
        />
      )}

      {/* Firefly 里已经有同名账户时问一句：新账单记进它吗。点一次以后不再出现。 */}
      <ChannelAccountBanner />

      {/*
        聚合横幅：要人动手的邮件。它是队列清不动的直接原因，所以留在首屏；
        真要动手（补密码、重新解析）都在二级页，这里只是入口。
      */}
      <StuckBanner />

      {/*
        列表的控制条：一级 tab + 渠道筛选，一起钉在滚动区顶端。
        清到第三百行也能直接切层、换来源、看清当前筛的是谁，不用先滚回顶上。
        日期分组头贴着它下沿吸附（--stick-h）。
      */}
      <div
        ref={stickyRef}
        className="sticky z-20 -mx-4 flex flex-col gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-0)] px-4 pt-2 pb-2 md:-mx-8 md:px-8"
        style={{ top: 'calc(var(--stick-pad, 0px) * -1)' }}
      >
        <div
          role="tablist"
          aria-label="收件箱分层"
          className="flex items-center gap-1 border-b border-[var(--border-subtle)]"
        >
          {INBOX_TABS.map((candidate) => (
            <button
              key={candidate}
              role="tab"
              type="button"
              aria-selected={tab === candidate}
              aria-controls="bill-inbox-queue"
              onClick={() => setTab(candidate)}
              className={`-mb-px shrink-0 border-b-2 px-3 py-1.5 text-[13px] font-medium transition-colors ${
                tab === candidate
                  ? 'border-[var(--brand)] text-[var(--brand-text)]'
                  : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              {INBOX_TAB_LABELS[candidate]}
              <span className="num ml-1.5 text-[11.5px] text-[var(--text-tertiary)]">
                {tabCountFor(candidate, source)}
              </span>
            </button>
          ))}
        </div>

        <ChannelBar
          groups={sourceGroups}
          counts={channelCounts}
          // 「全部来源」永远显示全渠道的总数：跟着选中渠道变的话，
          // 它和它旁边那个渠道 chip 会显示同一个数字，等于没这个 chip。
          totalCount={tabCountFor(tab)}
          loading={tasksQuery.isLoading}
          error={tasksQuery.error}
          onRetryLoad={() => void tasksQuery.refetch()}
          selectedSource={source ?? null}
          onSelectSource={setSourceFilter}
          selectedTaskId={taskFilter}
        />
      </div>

      <Card
        padded={false}
        // 节与节之间拉开一大档（gap-8），节头和它自己的内容贴着（SectionHead 的 pb-1.5）：
        // 亲密性决定了眼睛怎么分块，两处间距一样大的话三节读起来是一整片。
        className="flex flex-col gap-8 p-2"
        id="bill-inbox-queue"
        role="tabpanel"
        aria-label={INBOX_TAB_LABELS[tab]}
      >
        {/* 整箱都空（邮箱没连，或者连了还没解析出东西）时给引导，别只丢一句「没有流水」 */}
        {inboxIsBlank && rows.length === 0 && !importableQuery.isLoading && !doneQuery.isLoading ? (
          <InboxOnboardingCard
            mailboxReady={mailboxReady}
            hasRows={hasAnyRows}
            hasImported={counts.countFor('imported') > 0}
            syncing={syncBusy}
            onConnect={() => setSettingsOpen(true)}
            onSync={() => void handleSync()}
          />
        ) : pendingCleared ? (
          /*
            两节都空：换成一块完成态，而不是上下两个空节。
            成果数从已完成层的既有计数取，跟着当前渠道筛选走——只看招行的时候
            报全渠道的总数，那个数字和眼前这一屏说的不是一回事。
          */
          <PendingClearCard
            imported={counts.countFor('imported', source)}
            dismissed={counts.countFor('dismissed', source)}
            showTally={!summaryQuery.isLoading && !summaryQuery.isError}
            lastSync={lastSyncHint}
            syncing={syncBusy}
            note={filterNote}
            onSync={() => void handleSync()}
            onViewDone={() => setTab('done')}
          />
        ) : pendingActive ? (
          <>
            {/* ── 待入账 ───────────────────────────────────────────── */}
            <section id={PENDING_SECTION_IDS.importable} className="flex flex-col">
              <SectionHead
                title={copy.SECTION_IMPORTABLE_TITLE}
                count={importable.rows.length}
                total={importable.total}
                // 加载中或加载失败时不印计数：那时候的 0 是「还不知道」，
                // 印出来就成了「已显示 0 / 共 0 笔」这种自相矛盾的节头
                showCount={!importableQuery.isLoading && !importableQuery.isError}
                hint={copy.SECTION_IMPORTABLE_HINT}
                note={filterNote}
              >
                {importableIds.length > 0 && (
                  <>
                    <label className="flex items-center gap-1.5 text-[11.5px] text-[var(--text-secondary)]">
                      <input
                        type="checkbox"
                        aria-label={copy.SECTION_IMPORTABLE_SELECT_ALL_LABEL}
                        checked={allImportableSelected}
                        ref={(element) => {
                          if (element) element.indeterminate = !allImportableSelected && someImportableSelected
                        }}
                        onChange={toggleSelectAllImportable}
                        className="shrink-0"
                      />
                      {copy.SECTION_IMPORTABLE_SELECT_ALL}
                    </label>
                    {/*
                      唯一的主操作。窄屏上有勾选时让位给底部浮条，
                      两颗按钮不同时出现在屏幕上。
                    */}
                    <Button
                      variant="primary"
                      size="sm"
                      className={selectedCount > 0 ? 'max-sm:hidden' : ''}
                      disabled={importMutation.isPending}
                      onClick={() => void handleImport(primaryImportIds)}
                    >
                      {importMutation.isPending ? copy.IMPORT_BUTTON_BUSY : copy.importButton(primaryImportIds.length)}
                    </Button>
                  </>
                )}
              </SectionHead>

              {importableQuery.isLoading ? (
                <ListSkeleton
                  label={copy.listLoadingLabel(copy.SECTION_IMPORTABLE_TITLE)}
                  rows={counts.countFor('importable', source)}
                />
              ) : importableQuery.isError ? (
                <ListLoadError
                  error={importableQuery.error}
                  rows={counts.countFor('importable', source)}
                  onRetry={() => void importableQuery.refetch()}
                />
              ) : importable.rows.length === 0 ? (
                <EmptyState
                  compact
                  statusIcon="inbox"
                  message={copy.EMPTY_IMPORTABLE}
                  action={{ label: copy.SYNC_BUTTON_IDLE, onClick: () => void handleSync() }}
                />
              ) : (
                <DayGroups groups={dayGroups} today={today} render={(row) => (
                  <QueueRow key={row.id} {...rowProps(row, 'importable')} />
                )} />
              )}

              <LoadMore query={importableQuery} shown={importable.rows.length} total={importable.total} />
            </section>

            {/* ── 待确认 ───────────────────────────────────────────── */}
            <section id={PENDING_SECTION_IDS.attention} className="flex flex-col">
              <SectionHead
                title={copy.SECTION_ATTENTION_TITLE}
                count={attention.rows.length}
                total={attention.total}
                showCount={!attentionQuery.isLoading && !attentionQuery.isError}
                hint={copy.SECTION_ATTENTION_HINT}
              />

              {attentionQuery.isLoading ? (
                <ListSkeleton
                  label={copy.listLoadingLabel(copy.SECTION_ATTENTION_TITLE)}
                  rows={counts.countFor('attention', source)}
                />
              ) : attentionQuery.isError ? (
                <ListLoadError
                  error={attentionQuery.error}
                  rows={counts.countFor('attention', source)}
                  onRetry={() => void attentionQuery.refetch()}
                />
              ) : attention.rows.length === 0 ? (
                // 这一节空着是好消息，不该配一个「下一步」按钮把人往别处支
                <p className="px-2 py-3 text-[11.5px] text-[var(--text-tertiary)]">
                  {copy.EMPTY_ATTENTION}
                </p>
              ) : (
                <div className="flex flex-col gap-5">
                  {rowSections.map((section) => {
                    const paired = section.kind === 'pairing_suggested'
                    return (
                      <div key={section.kind} className="flex flex-col">
                        <div className="px-2 pb-1.5">
                          <h3 className="text-[12px] font-semibold text-[var(--text-primary)]">
                            {section.label}{' '}
                            {/*
                              「疑似同一笔」按**对**数：下面摆的是成对卡，一对一张。
                              这里报 6 笔、下面摆 3 张卡，人会以为少了三张。
                              待确认那个合计仍按行数，见 useTodoCounts 的口径注释。
                            */}
                            <span className="num">
                              {paired
                                ? copy.pairSectionCount(
                                    pairEntries.filter((entry) => entry.kind === 'pair').length,
                                    pairEntries.filter((entry) => entry.kind === 'single').length,
                                  )
                                : `${section.rows.length} 笔`}
                            </span>
                          </h3>
                          {/* 每节说清楚：要判断什么、判完会怎样 */}
                          <p className="mt-0.5 text-[11px] text-[var(--text-tertiary)]">
                            {paired ? copy.pairSectionHint(pairScopeOf(pairEntries)) : section.hint}
                          </p>
                        </div>
                        {/*
                          「疑似同一笔」按对渲染：一对折成一张卡，落单的（对侧已经
                          入账或忽略）退回普通行。其余小节还是逐行。
                        */}
                        {paired
                          ? pairEntries.map((entry) => (
                              entry.kind === 'pair'
                                ? <PairCard key={entry.key} left={entry.left} right={entry.right} />
                                : (
                                    <div key={entry.key} className="flex flex-col">
                                      <QueueRow {...rowProps(entry.row, 'attention')} attentionKind={section.kind} />
                                      {entry.orphan && (
                                        <p className="px-2 pb-1 text-[11px] text-[var(--text-tertiary)]">
                                          {copy.PAIR_ORPHAN_NOTE}
                                        </p>
                                      )}
                                    </div>
                                  )
                            ))
                          : section.rows.map((row) => (
                              <QueueRow key={row.id} {...rowProps(row, 'attention')} attentionKind={section.kind} />
                            ))}
                      </div>
                    )
                  })}
                </div>
              )}

              <LoadMore query={attentionQuery} shown={attention.rows.length} total={attention.total} />
            </section>
          </>
        ) : (
          /* ── 已完成 ──────────────────────────────────────────────── */
          <section className="flex flex-col">
            <SectionHead
              title={DONE_VIEW_LABELS[doneView]}
              count={done.rows.length}
              total={done.total}
              showCount={!doneQuery.isLoading && !doneQuery.isError}
              hint={doneView === 'imported' ? copy.SECTION_IMPORTED_HINT : copy.SECTION_DISMISSED_HINT}
              note={filterNote}
            >
              <SegmentedControl
                aria-label={copy.DONE_SEGMENT_LABEL}
                segments={DONE_VIEWS.map((value) => ({ value, label: DONE_VIEW_LABELS[value] }))}
                value={doneView}
                onChange={setDoneView}
              />
            </SectionHead>

            {doneQuery.isLoading ? (
              <ListSkeleton
                label={copy.listLoadingLabel(DONE_VIEW_LABELS[doneView])}
                rows={counts.countFor(doneView, source)}
              />
            ) : doneQuery.isError ? (
              <ListLoadError
                error={doneQuery.error}
                rows={counts.countFor(doneView, source)}
                onRetry={() => void doneQuery.refetch()}
              />
            ) : done.rows.length === 0 ? (
              <EmptyState
                compact
                statusIcon="inbox"
                message={doneView === 'imported' ? copy.EMPTY_IMPORTED : copy.EMPTY_DISMISSED}
                action={{ label: copy.EMPTY_GOTO_PENDING, onClick: () => setTab('pending') }}
              />
            ) : doneView === 'imported' ? (
              <BatchGroups
                groups={doneBatchGroups}
                undoing={undoImportMutation.isPending}
                onUndoBatch={setUndoBatch}
                render={(row) => <QueueRow key={row.id} {...rowProps(row, doneView)} />}
              />
            ) : (
              <DayGroups groups={doneDayGroups} today={today} render={(row) => (
                <QueueRow key={row.id} {...rowProps(row, doneView)} />
              )} />
            )}

            <LoadMore query={doneQuery} shown={done.rows.length} total={done.total} />
          </section>
        )}

        {rows.length > 0 && (
          <p className="px-2 pb-1 text-[11.5px] text-[var(--text-tertiary)]">
            {aiSuggestedCount > 0 && <>{copy.aiSuggestedNote(aiSuggestedCount)} · </>}
            {selectable ? copy.KEYBOARD_HINT_FULL : copy.KEYBOARD_HINT_BROWSE}
          </p>
        )}
      </Card>

      {/*
        窄屏的批量操作栏：勾选后吸底出现，替代节头上那颗主按钮（两者互斥）。
        宽屏不出现——节头就在视野里，再吸一条底等于同屏两个主操作。
        手机底部有小白条（home indicator）和底部 tab 栏（h-16 + 安全区，z-150），
        操作栏必须垫到 tab 栏上方并且层级更高，否则勾选后按钮点不到。
      */}
      {selectedCount > 0 && (
        <div
          className={
            'pointer-events-none fixed inset-x-0 bottom-0 z-[160] flex justify-center p-4 sm:hidden '
            + 'pb-[calc(5rem+env(safe-area-inset-bottom))]'
          }
        >
          <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-lg bg-[var(--surface-2)] px-3 py-2 shadow-[var(--shadow-pop)] ring-1 ring-[var(--border-subtle)]">
            <span className="num text-[12.5px] text-[var(--text-primary)]">
              {copy.selectedCountNote(selectedCount)}
            </span>
            <Button
              variant="primary"
              size="sm"
              disabled={importMutation.isPending}
              onClick={() => void handleImport(Array.from(selected))}
            >
              {importMutation.isPending ? copy.IMPORT_BUTTON_BUSY : copy.importButton(selectedCount)}
            </Button>
            <Button
              variant="ghost-danger"
              size="sm"
              disabled={dismissMutation.isPending}
              onClick={() => void handleDismiss(Array.from(selected))}
            >
              {copy.dismissButton(selectedCount)}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => dispatchSelection({ type: 'clearSelection' })}>
              {copy.CANCEL_SELECTION}
            </Button>
          </div>
        </div>
      )}

      <ImportConfirmDialog
        open={dryRun !== null}
        title={copy.confirmImportTitle(confirmRowIds.length)}
        dryRun={dryRun}
        pending={importMutation.isPending}
        onCancel={() => {
          setDryRun(null)
          setConfirmRowIds([])
        }}
        onConfirm={() => void handleConfirmImport()}
      />

      {/*
        整批撤回要说清后果：这不是「从列表里拿掉」，是去账本里把那几笔交易删掉。
        写明笔数和去向，人才能判断该不该点。
      */}
      <ConfirmDialog
        open={undoBatch !== null}
        title={copy.batchUndoTitle(undoBatch?.rows.length ?? 0)}
        confirmLabel={copy.BATCH_UNDO_CONFIRM}
        pendingLabel={copy.BATCH_UNDO_BUSY}
        pending={undoImportMutation.isPending}
        onClose={() => setUndoBatch(null)}
        onConfirm={() => {
          const rowIds = undoBatch?.rows.map((row) => row.id) ?? []
          setUndoBatch(null)
          void undoImport(rowIds)
        }}
      >
        <p>{copy.batchUndoBody(undoBatch?.rows.length ?? 0)}</p>
        <p className="text-[11.5px] text-[var(--text-tertiary)]">{copy.BATCH_UNDO_NOTE}</p>
      </ConfirmDialog>

      <BillInboxSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}

/** 一组分页结果摊平 + 前端兜底过滤，三处（待入账 / 待确认 / 已完成）共用 */
function useRowSlice(
  pages: { data: BillQueueRow[] }[] | undefined,
  filter: (rows: BillQueueRow[]) => BillQueueRow[],
): { rows: BillQueueRow[]; total: number } {
  return useMemo(() => {
    const { rows: all, total } = flattenBillRows(pages as never)
    const rows = filter(all)
    // 前端兜底筛过就只能报筛后的数：服务端那个 total 说的是没筛的那一批
    return { rows, total: rows.length === all.length ? total : rows.length }
  }, [pages, filter])
}

/**
 * 分节头：标题 + 已显示/共多少 + 一句说明 + 右侧动作。
 * 三个分节共用一个形状，「这一节是干什么的」永远在同一个位置。
 */
function SectionHead({
  title,
  count,
  total,
  showCount = true,
  hint,
  note,
  children,
}: {
  title: string
  count: number
  total: number
  /** 加载中 / 加载失败时传 false：那时候的数字是「还不知道」，印出来就是在撒谎 */
  showCount?: boolean
  hint: string
  note?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-2 pb-1.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">
            {title}
            {/* 计数比标题低一档：它是标题的注脚，不是并列的第二个标题 */}
            {showCount && (
              <span className="num ml-1.5 text-[11.5px] font-normal text-[var(--text-tertiary)]">
                {copy.sectionCount(count, total)}
              </span>
            )}
          </h2>
          {note}
        </div>
        <p className="text-[11px] text-[var(--text-tertiary)]">{hint}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  )
}

/** 日期分组渲染。分组头粘在控制条下沿，带当日笔数与合计。 */
function DayGroups({
  groups,
  today,
  render,
}: {
  groups: { day: string; rows: BillQueueRow[]; totals: CurrencyTotal[] }[]
  today: string
  render: (row: BillQueueRow) => ReactNode
}) {
  return (
    <div className="flex flex-col">
      {groups.map((group) => (
        <div key={group.day} className="flex flex-col">
          {/*
            日期分组头。合计和每行金额右对齐在同一根线上 —— 一天花了多少，扫过去就有数。
            让开的宽度由金额列宽算出来（--bill-total-pad），不再是另写一个字面量。
          */}
          <div
            className="sticky z-10 flex items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-1)] px-2 py-1"
            style={{ top: 'calc(var(--stick-h, 0px) - var(--stick-pad, 0px))' }}
          >
            <span className="num text-[11.5px] font-semibold text-[var(--text-primary)]">
              {group.day === '--' ? '没有日期' : formatMonthDay(group.day)}
            </span>
            <span className="text-[11px] text-[var(--text-tertiary)]">
              {relativeDayLabel(group.day, today) ?? ''}
            </span>
            <span className="num text-[11px] text-[var(--text-tertiary)]">{group.rows.length} 笔</span>
            {/* 当日合计按币种分开印，不同币种之间不做换算也不相加 */}
            <span className="num ml-auto pr-[var(--bill-total-pad)] text-[11.5px] text-[var(--text-secondary)]">
              {group.totals
                .filter((entry) => entry.net !== 0)
                .map((entry) => formatSignedMoney(entry.net, entry.symbol, formatAmount))
                .join('  ')}
            </span>
          </div>
          {group.rows.map((row) => render(row))}
        </div>
      ))}
    </div>
  )
}

/**
 * 已入账按批次渲染：一组就是一次入账动作写进去的那几行，组头给「撤回这批」。
 *
 * 撤回的对象必须和当初入账的对象一模一样。按日期分组的话，组头上那颗按钮撤的是
 * 「这一天入的所有账」——包含另外几次入账的结果，用户根本没打算动它们。
 */
function BatchGroups({
  groups,
  undoing,
  onUndoBatch,
  render,
}: {
  groups: ImportBatchGroup[]
  undoing: boolean
  onUndoBatch: (group: ImportBatchGroup) => void
  render: (row: BillQueueRow) => ReactNode
}) {
  return (
    <div className="flex flex-col">
      {groups.map((group) => (
        <div key={group.batchId ?? 'legacy'} className="flex flex-col">
          <div
            className="sticky z-10 flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-[var(--border-subtle)] bg-[var(--surface-1)] px-2 py-1"
            style={{ top: 'calc(var(--stick-h, 0px) - var(--stick-pad, 0px))' }}
          >
            <span className="num text-[11.5px] font-semibold text-[var(--text-primary)]">
              {group.batchId === null
                ? copy.BATCH_LEGACY_TITLE
                : group.at
                  ? formatDateTime(group.at)
                  : copy.BATCH_LEGACY_TITLE}
            </span>
            <span className="num text-[11px] text-[var(--text-tertiary)]">
              {copy.batchHeadCount(group.rows.length)}
            </span>
            {/* 合计按币种分开印，不同币种之间不做换算也不相加 */}
            <span className="num text-[11px] text-[var(--text-secondary)]">
              {group.totals
                .filter((entry) => entry.net !== 0)
                .map((entry) => `· ${formatSignedMoney(entry.net, entry.symbol, formatAmount)}`)
                .join('  ')}
            </span>
            {group.batchId === null ? (
              <span className="ml-auto text-[11px] text-[var(--text-tertiary)]">
                {copy.BATCH_LEGACY_HINT}
              </span>
            ) : (
              <Button
                variant="ghost-danger"
                size="xs"
                className="ml-auto"
                disabled={undoing}
                onClick={() => onUndoBatch(group)}
              >
                {undoing ? copy.BATCH_UNDO_BUSY : copy.BATCH_UNDO}
              </Button>
            )}
          </div>
          {group.rows.map((row) => render(row))}
        </div>
      ))}
    </div>
  )
}

/**
 * 滚动加载哨兵 + 「已显示 N / 共 M」。
 *
 * 每一节自带一个：三节共用一个哨兵的话，任何一节滚到底都会去续别人的页。
 */
function LoadMore({
  query,
  shown,
  total,
}: {
  query: {
    hasNextPage: boolean
    isFetchingNextPage: boolean
    fetchNextPage: () => unknown
  }
  shown: number
  total: number
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query

  /** 没有 IntersectionObserver 的环境（jsdom）直接不装，列表照常渲染 */
  useEffect(() => {
    const element = ref.current
    if (!element || typeof IntersectionObserver === 'undefined') return
    if (!hasNextPage) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && !isFetchingNextPage) void fetchNextPage()
    }, { rootMargin: '400px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [fetchNextPage, hasNextPage, isFetchingNextPage])

  if (shown === 0) return null
  return (
    <div ref={ref} className="px-2 pt-3 pb-1 text-center text-[11.5px] text-[var(--text-tertiary)]">
      {copy.loadMoreNote(hasNextPage || isFetchingNextPage, shown, total)}
    </div>
  )
}

/**
 * 占位行数按「这一节上一次有多少笔」给，不写死 6 行——
 * 写死的话加载完必然跳一下，差得越多跳得越明显。
 */
function ListSkeleton({ label, rows }: { label: string; rows: number }) {
  const count = Math.min(Math.max(rows || 8, 3), BILL_ROWS_PAGE_SIZE)
  return (
    <div className="flex flex-col gap-1 p-2" role="status" aria-label={label}>
      {Array.from({ length: count }).map((_, index) => <Skeleton key={index} className="h-8" />)}
    </div>
  )
}

/**
 * 某一节没加载出来。
 *
 * 原来这里是一个居中的大图标错误态，一块本该装二十行流水的地方被一个感叹号
 * 顶掉，另外两节还在正常显示——同一屏上三种版式，坏的那一节看着像整页崩了。
 * 改成一行内联的说明加重试，列表的位置留骨架占位：版式不变，坏的只是内容。
 */
function ListLoadError({ error, rows, onRetry }: { error: unknown; rows: number; onRetry: () => void }) {
  const count = Math.min(Math.max(rows || 4, 2), 6)
  return (
    <div className="flex flex-col gap-1 p-2">
      <InlineError message={copy.LIST_ERROR} error={error} onRetry={onRetry} />
      {/* 骨架只是占位，不是「在加载」——读屏不该听见它 */}
      <div aria-hidden className="flex flex-col gap-1 opacity-50">
        {Array.from({ length: count }).map((_, index) => <Skeleton key={index} className="h-8" />)}
      </div>
    </div>
  )
}
