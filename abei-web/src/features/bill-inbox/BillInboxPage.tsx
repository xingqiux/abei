import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { ArrowsClockwise, Gear, Sparkle } from '@phosphor-icons/react'
import {
  invalidateBillInbox,
  useBillInboxSummary,
  useBillRows,
  useBillRowsCount,
  useBillRowsCountByChannel,
  useBillTasks,
  useDeleteTransaction,
  useDismissBillRows,
  useImportBillRows,
  useRestoreBillRows,
  useSyncBillInbox,
} from '../../api/queries'
import { AssistantApiError, runAutofill } from '../../api/assistant'
import type { BillImportResponse, BillQueueRow, BillTask } from '../../api/schemas'
import { EmptyState } from '../../components/abei/EmptyState'
import { Skeleton } from '../../components/abei/Skeleton'
import { ErrorState, InlineError } from '../../components/abei/ErrorState'
import { Button, IconButton } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { showToast } from '../../store/toastStore'
import { AbeiApiError } from '../../api/client'
import { BillInboxSettingsDialog } from './BillInboxSettingsDialog'
import { ImportConfirmDialog } from './ImportConfirmDialog'
import { QueueRow } from './QueueRow'
import { ChannelBar, type SourceGroup } from './ChannelBar'
import { BRAND_MARKS, type PlatformKey } from './brandMarks'
import {
  channelDisplayName,
  CLOSED_TASK_STATUSES,
  DEFAULT_INBOX_VIEW,
  groupAttentionRows,
  groupRowsByDay,
  INBOX_VIEW_LABELS,
  INBOX_VIEWS,
  isAiSuggested,
  isRowSelectable,
  needsAutofill,
  relativeDayLabel,
  SOURCE_FALLBACK_LABELS,
  syncResultFeedback,
  workloadOf,
  type InboxView,
} from './billInboxHelpers'
import { formatAmount, formatMonthDay } from '../../lib/format'

/** 超过这个数才弹干跑确认；以下直接执行 + 撤销窗口（设计稿 02 §4） */
const DIRECT_IMPORT_LIMIT = 20

/** 撤销那条 toast 留久一点：8 秒里没点，就当人是认下了 */
const UNDO_TOAST_DURATION = 8000

/**
 * 滚动加载一次续多少行。不做分页器：这一页的活是「从上往下清掉」，
 * 翻页会把「清到哪儿了」这条线打断。到底了会明说「共 N 笔」，不留悬念。
 */
const SCROLL_STEP = 40

export function BillInboxPage() {
  const search = useSearch({ from: '/bill-inbox' })
  const navigate = useNavigate({ from: '/bill-inbox' })
  const source = search.source
  const view: InboxView = search.view ?? DEFAULT_INBOX_VIEW
  const taskFilter = search.task ?? null

  const queryClient = useQueryClient()
  const summaryQuery = useBillInboxSummary()
  const syncMutation = useSyncBillInbox()
  const dismissMutation = useDismissBillRows()
  const restoreMutation = useRestoreBillRows()
  const importMutation = useImportBillRows()
  const deleteTransaction = useDeleteTransaction()
  const requestedSync = useRef<string | null>(null)

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [anchorIndex, setAnchorIndex] = useState<number | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [cursorIndex, setCursorIndex] = useState(0)
  const [dryRun, setDryRun] = useState<BillImportResponse | null>(null)
  const [confirmRowIds, setConfirmRowIds] = useState<string[]>([])
  const [autofillRunning, setAutofillRunning] = useState(false)
  /** 滚动加载已经放出来多少行 */
  const [shown, setShown] = useState(SCROLL_STEP)
  /** 这一趟处理掉了多少笔，工作量条上的进度就是它 */
  const [handledCount, setHandledCount] = useState(0)
  const pageRef = useRef<HTMLDivElement | null>(null)
  const stickyRef = useRef<HTMLDivElement | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  /** 当前 tab 的行；其余三个 tab 不请求，切过去再拉 */
  const rowsQuery = useBillRows(view, { source })
  const counts = {
    importable: useBillRowsCount('importable', { source }),
    attention: useBillRowsCount('attention', { source }),
    dismissed: useBillRowsCount('dismissed', { source }),
    imported: useBillRowsCount('imported', { source }),
  }

  // 来源面板要的是整箱邮件，故意不跟着当前渠道过滤走：面板本身就是换渠道的地方，
  // 跟着过滤会把「换一个渠道看看」这条路自己堵死。
  const tasksQuery = useBillTasks()

  const allRows = useMemo(() => rowsQuery.data?.data ?? [], [rowsQuery.data])
  const rows = useMemo(
    () => (taskFilter === null ? allRows : allRows.filter((row) => String(row.attributes.bill_task_id) === taskFilter)),
    [allRows, taskFilter],
  )
  const attentionSections = useMemo(() => groupAttentionRows(rows), [rows])

  const channelName = useCallback(
    (key: string) => channelDisplayName(key, summaryQuery.data?.channels.find((channel) => channel.key === key)?.name),
    [summaryQuery.data],
  )

  const sourceGroups = useMemo<SourceGroup[]>(() => {
    const tasks = (tasksQuery.data?.data ?? []).filter(
      (task) => !CLOSED_TASK_STATUSES.includes(task.attributes.status),
    )
    const byChannel = new Map<string, BillTask[]>()
    // 渠道以 summary 为准：某个渠道这会儿没有解析中的邮件，它名下的流水还在队列里，
    // chip 不能因此消失 —— 否则「只看招行」这条路会时有时无。
    for (const channel of summaryQuery.data?.channels ?? []) byChannel.set(channel.key, [])
    for (const task of tasks) {
      const key = task.attributes.source
      const list = byChannel.get(key)
      if (list) list.push(task)
      else byChannel.set(key, [task])
    }
    return Array.from(byChannel.entries())
      .map(([key, list]) => ({
        key,
        label: channelName(key) || SOURCE_FALLBACK_LABELS[key] || key,
        platform: (key in BRAND_MARKS ? key : 'other') as PlatformKey,
        // 新邮件在上：找「刚同步下来的那封」比找三个月前那封频繁得多
        tasks: [...list].sort((a, b) =>
          (b.attributes.received_at ?? '').localeCompare(a.attributes.received_at ?? '')),
      }))
      .sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'))
  }, [tasksQuery.data, summaryQuery.data, channelName])

  /** 渠道 chip 上的笔数：每个渠道一个 limit=1 的轻请求，只取 meta 总数 */
  const channelKeys = useMemo(() => sourceGroups.map((group) => group.key), [sourceGroups])
  const channelCountQueries = useBillRowsCountByChannel(view, channelKeys)
  const channelCounts = useMemo(() => {
    const out: Record<string, number | undefined> = {}
    channelKeys.forEach((key, index) => {
      out[key] = channelCountQueries[index]?.data
    })
    return out
  }, [channelKeys, channelCountQueries])

  /**
   * 滚动加载：只渲染前 shown 行。待确认 tab 按判断类型分小节，本来就不长，整段出。
   * 真上到几千行时这里还得再加虚拟滚动，眼下 DOM 里最多 SCROLL_STEP 的整数倍。
   */
  const visibleRows = useMemo(
    () => (view === 'attention' ? rows : rows.slice(0, shown)),
    [view, rows, shown],
  )
  const dayGroups = useMemo(() => groupRowsByDay(visibleRows), [visibleRows])
  const workload = useMemo(() => workloadOf(rows), [rows])
  const currencySymbol = rows[0]?.attributes.currency_symbol ?? rows[0]?.attributes.currency_code ?? ''
  const today = new Date().toLocaleDateString('sv-SE')

  /** j/k 走的是屏幕上看到的顺序：待确认 tab 分了小节，顺序按小节来；没放出来的行不算 */
  const cursorRows = useMemo(
    () => (view === 'attention' ? attentionSections.flatMap((section) => section.rows) : visibleRows),
    [view, visibleRows, attentionSections],
  )

  const selectable = view === 'importable' || view === 'attention'
  const selectableIds = useMemo(
    () => (selectable ? rows.filter(isRowSelectable).map((row) => row.id) : []),
    [rows, selectable],
  )
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id))
  const someSelected = selectableIds.some((id) => selected.has(id))
  const aiSuggestedCount = useMemo(() => rows.filter(isAiSuggested).length, [rows])
  const autofillPending = useMemo(() => rows.some(needsAutofill), [rows])
  const mailboxSync = summaryQuery.data?.mailbox_sync
  const mailboxSyncActive = mailboxSync?.status === 'queued' || mailboxSync?.status === 'running'
  const syncBusy = syncMutation.isPending || mailboxSyncActive

  // 换 tab / 换渠道 / 换邮件后，之前选中的行已经不在屏幕上了，留着选中状态只会误伤
  useEffect(() => {
    setSelected(new Set())
    setAnchorIndex(null)
    setExpandedId(null)
    setEditingId(null)
    setCursorIndex(0)
    setShown(SCROLL_STEP)
  }, [source, view, taskFilter])

  /**
   * 两层粘性要对齐：顶部条钉在滚动区顶端，日期分组头贴着它的下沿。
   *
   * 两个数都得量：条子的高度会随「选中渠道后多出一行邮件 chip」变化；而浏览器把
   * 吸附线放在滚动容器的内容盒上 —— 也就是被 main 的上内边距推低了一截，
   * 不把这一截让回去，条子和视口顶端之间会露出一条缝，列表正好从缝里穿过去。
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

  /** 滚到底就再放一批。没有 IntersectionObserver 的环境（jsdom）直接不装，列表照常渲染 */
  useEffect(() => {
    const element = sentinelRef.current
    if (!element || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setShown((value) => value + SCROLL_STEP)
    }, { rootMargin: '400px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [rows.length, shown])

  function setView(next: InboxView) {
    void navigate({ search: { source, view: next === DEFAULT_INBOX_VIEW ? undefined : next, task: taskFilter ?? undefined }, replace: true })
  }

  /**
   * 选一封邮件时把渠道留着：邮件 chip 本来就长在选中的那个渠道下面，
   * 顺手清掉渠道的话，这一排邮件会在点下去的同一瞬间收起来。
   */
  function setTaskFilter(next: string | null) {
    void navigate({
      search: { source, view: search.view, task: next ?? undefined },
      replace: true,
    })
  }

  /** 反过来则要清：换了渠道，还钉在上一个渠道那封邮件上只会得到空列表 */
  function setSourceFilter(next: string | null) {
    void navigate({
      search: { source: next ?? undefined, view: search.view, task: undefined },
      replace: true,
    })
  }

  function clearFilters() {
    void navigate({ search: { source: undefined, view: search.view, task: undefined }, replace: true })
  }

  function toggleSelect(rowId: string, index: number, shift: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (shift && anchorIndex !== null) {
        const [from, to] = anchorIndex <= index ? [anchorIndex, index] : [index, anchorIndex]
        // 区间选统一改成「选上」，不做逐行反转：反转出来的结果没人能预期
        for (let i = from; i <= to; i += 1) {
          const id = cursorRows[i]?.id
          if (id && selectableIds.includes(id)) next.add(id)
        }
        return next
      }
      if (next.has(rowId)) next.delete(rowId)
      else next.add(rowId)
      return next
    })
    setAnchorIndex(index)
  }

  function toggleSelectAll() {
    setSelected(allSelected ? new Set() : new Set(selectableIds))
    setAnchorIndex(null)
  }

  useEffect(() => {
    if (
      requestedSync.current === null
      || mailboxSync?.requested_at !== requestedSync.current
      || mailboxSync.status === 'queued'
      || mailboxSync.status === 'running'
    ) return

    requestedSync.current = null
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
  }, [mailboxSync, queryClient])

  async function handleSync() {
    if (syncBusy) return
    try {
      const res = await syncMutation.mutateAsync({})
      requestedSync.current = res.data.attributes.requested_at
      void summaryQuery.refetch()
      showToast({ kind: 'success', message: '邮箱同步已加入队列' })
    } catch (err) {
      showToast({
        kind: 'error',
        message: err instanceof AbeiApiError ? err.message : '同步邮件失败，请稍后重试',
        duration: 6000,
      })
    }
  }

  async function handleAutofill() {
    if (autofillRunning) return
    setAutofillRunning(true)
    try {
      const result = await runAutofill()
      showToast({
        kind: 'success',
        message: `AI 已给出 ${result.rows} 笔建议（来自 ${result.tasks} 封邮件）`,
      })
      void rowsQuery.refetch()
    } catch (err) {
      // 409 = 后台已经在跑。这不是出错，别拿红色吓人
      if (err instanceof AssistantApiError && err.status === 409) {
        showToast({ kind: 'success', message: 'AI 已开始处理，完成后刷新查看' })
        return
      }
      showToast({
        kind: 'error',
        message: err instanceof Error ? err.message : 'AI 出建议失败，请稍后重试',
        duration: 6000,
      })
    } finally {
      setAutofillRunning(false)
    }
  }

  /** 撤销 = 删掉刚建出来的交易组。行会回到 pending，重新出现在队列里。 */
  function undoTargets(response: BillImportResponse): string[] {
    return Array.from(
      new Set(
        response.rows
          .filter((row) => row.action === 'imported' && row.transaction_group_id != null)
          .map((row) => String(row.transaction_group_id)),
      ),
    )
  }

  async function undoImport(groupIds: string[]) {
    try {
      for (const groupId of groupIds) {
        await deleteTransaction.mutateAsync(groupId)
      }
      showToast({ kind: 'success', message: `已撤销 ${groupIds.length} 笔交易` })
    } catch (err) {
      showToast({
        kind: 'error',
        message: err instanceof AbeiApiError ? err.message : '撤销失败，可到交易页手动删除',
        duration: 8000,
      })
    }
  }

  async function runImport(rowIds: string[]) {
    const res = await importMutation.mutateAsync({ rowIds, confirm: true })
    setSelected(new Set())
    setAnchorIndex(null)
    if (res.summary.failed > 0) {
      showToast({
        kind: 'error',
        message: `入账 ${res.summary.imported} 笔，失败 ${res.summary.failed} 笔`,
        duration: 6000,
      })
      return
    }
    setHandledCount((value) => value + res.summary.imported)
    const groupIds = undoTargets(res)
    showToast({
      kind: 'success',
      message: `已入账 ${res.summary.imported} 笔`,
      duration: UNDO_TOAST_DURATION,
      action: groupIds.length > 0
        ? { label: '撤销', onClick: () => void undoImport(groupIds) }
        : undefined,
    })
  }

  async function handleImport(rowIds: string[]) {
    if (rowIds.length === 0 || importMutation.isPending) return
    try {
      if (rowIds.length <= DIRECT_IMPORT_LIMIT) {
        await runImport(rowIds)
        return
      }
      // 一次几百笔的时候先给一份干跑清单：这个动作没法只撤销「其中错的那几笔」
      const preview = await importMutation.mutateAsync({ rowIds, confirm: false })
      setDryRun(preview)
      setConfirmRowIds(preview.rows.filter((row) => row.action === 'would_import').map((row) => row.row_id))
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
      await dismissMutation.mutateAsync({ row_ids: rowIds })
      setHandledCount((value) => value + rowIds.length)
      setSelected((prev) => {
        const next = new Set(prev)
        rowIds.forEach((id) => next.delete(id))
        return next
      })
      showToast({
        kind: 'success',
        message: `已忽略 ${rowIds.length} 笔`,
        duration: UNDO_TOAST_DURATION,
        action: { label: '撤销', onClick: () => void handleRestore(rowIds, { silent: true }) },
      })
    } catch (err) {
      showToast({
        kind: 'error',
        message: err instanceof AbeiApiError ? err.message : '忽略失败，请重试',
        duration: 6000,
      })
    }
  }

  async function handleRestore(rowIds: string[], opts: { silent?: boolean } = {}) {
    if (rowIds.length === 0) return
    try {
      await restoreMutation.mutateAsync(rowIds)
      showToast({
        kind: 'success',
        message: opts.silent ? `已撤销，${rowIds.length} 笔回到待入账` : `已恢复 ${rowIds.length} 笔`,
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
   * 键盘流：j/k 上下、x 勾选、e 编辑、d 忽略、Enter 入账所选。
   * TODO(命令面板)：设计稿要求把这套快捷键也登记进 Cmd+K 的说明里，
   * 但 features/command-palette 归另一位负责，等那边开口子再接。
   */
  useEffect(() => {
    if (!selectable || editingId) return
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

      if (event.key === 'j' || event.key === 'ArrowDown') {
        event.preventDefault()
        setCursorIndex(Math.min(index + 1, list.length - 1))
      } else if (event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault()
        setCursorIndex(Math.max(index - 1, 0))
      } else if (event.key === 'x') {
        event.preventDefault()
        if (isRowSelectable(row)) toggleSelect(row.id, index, false)
      } else if (event.key === 'e') {
        event.preventDefault()
        setEditingId(row.id)
      } else if (event.key === 'd') {
        event.preventDefault()
        void handleDismiss([row.id])
      } else if (event.key === 'Enter') {
        event.preventDefault()
        void handleImport(selected.size > 0 ? Array.from(selected) : isRowSelectable(row) ? [row.id] : [])
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectable, editingId, cursorRows, cursorIndex, selected])

  useEffect(() => {
    const row = cursorRows[cursorIndex]
    if (!row) return
    document.getElementById(`bill-row-${row.id}`)?.scrollIntoView({ block: 'nearest' })
  }, [cursorIndex, cursorRows])

  const cursorRowId = cursorRows[cursorIndex]?.id ?? null
  const selectedCount = selected.size
  const primaryImportIds = selectedCount > 0 ? Array.from(selected) : selectableIds
  const selectedTaskLabel = taskFilter === null
    ? null
    : sourceGroups.flatMap((group) => group.tasks).find((task) => task.id === taskFilter)?.attributes.summary ?? null

  function rowProps(row: BillQueueRow, index: number) {
    return {
      row,
      mode: view,
      selectable: selectable && isRowSelectable(row),
      selected: selected.has(row.id),
      onSelect: (shift: boolean) => toggleSelect(row.id, index, shift),
      focused: cursorRowId === row.id,
      expanded: expandedId === row.id,
      onToggleExpand: () => setExpandedId(expandedId === row.id ? null : row.id),
      editing: editingId === row.id,
      onStartEdit: () => setEditingId(row.id),
      onEndEdit: () => setEditingId(null),
      onDismiss: selectable ? () => void handleDismiss([row.id]) : undefined,
      onRestore: view === 'dismissed' ? () => void handleRestore([row.id]) : undefined,
      busy: dismissMutation.isPending || restoreMutation.isPending,
    }
  }

  return (
    <div ref={pageRef} className="flex flex-col gap-4 pb-16">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h1 className="text-lg font-semibold text-[var(--text-primary)]">账单收件箱</h1>
          {/* 常驻的一句定位说明：这一页到底装的是什么、处理完去哪儿 */}
          <p className="text-xs text-[var(--text-secondary)]">
            从邮箱账单解析出的流水；入账后进入交易。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {autofillPending && (
            <Button variant="secondary" size="sm" disabled={autofillRunning} onClick={() => void handleAutofill()}>
              <Sparkle aria-hidden className="size-4" />
              {autofillRunning ? '正在出建议…' : '让 AI 出建议'}
            </Button>
          )}
          <Button variant="secondary" size="sm" disabled={syncBusy} onClick={() => void handleSync()}>
            <ArrowsClockwise aria-hidden className={`size-4 ${syncBusy ? 'animate-spin' : ''}`} />
            {syncMutation.isPending
              ? '正在提交…'
              : mailboxSync?.status === 'queued'
                ? '等待同步…'
                : mailboxSync?.status === 'running'
                  ? '正在同步邮件…'
                  : '同步邮件'}
          </Button>
          <IconButton label="邮箱设置" onClick={() => setSettingsOpen(true)}>
            <Gear aria-hidden className="size-4" />
          </IconButton>
        </div>
      </header>

      {summaryQuery.isError && (
        <InlineError message="收件箱汇总加载失败" error={summaryQuery.error} onRetry={() => void summaryQuery.refetch()} />
      )}

      {view === 'importable' && rows.length > 0 && (
        <Workload
          count={workload.count}
          expense={workload.expense}
          income={workload.income}
          earliestDay={workload.earliestDay}
          today={today}
          symbol={currencySymbol}
          handled={handledCount}
        />
      )}

      {/*
        状态 tab 和渠道条一起钉在滚动区顶端：清到第三百行也能直接切状态、换来源、
        看清当前筛的是谁，不用先滚回顶上。日期分组头贴着它下沿吸附（--stick-h）。
      */}
      <div
        ref={stickyRef}
        className="sticky z-20 -mx-4 flex flex-col gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-0)] px-4 pt-2 pb-2 md:-mx-8 md:px-8"
        style={{ top: 'calc(var(--stick-pad, 0px) * -1)' }}
      >
        <div role="tablist" aria-label="流水状态" className="flex flex-wrap items-center gap-1 border-b border-[var(--border-subtle)]">
          {INBOX_VIEWS.map((candidate) => (
            <button
              key={candidate}
              role="tab"
              type="button"
              aria-selected={view === candidate}
              aria-controls="bill-inbox-queue"
              onClick={() => setView(candidate)}
              className={`-mb-px border-b-2 px-3 py-1.5 text-[13px] font-medium transition-colors ${
                view === candidate
                  ? 'border-[var(--brand)] text-[var(--brand-text)]'
                  : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              {INBOX_VIEW_LABELS[candidate]}
              <span className="num ml-1.5 text-[11.5px] text-[var(--text-tertiary)]">
                {counts[candidate].data ?? 0}
              </span>
            </button>
          ))}
        </div>

        <ChannelBar
          groups={sourceGroups}
          counts={channelCounts}
          totalCount={counts[view].data ?? 0}
          loading={tasksQuery.isLoading}
          error={tasksQuery.error}
          onRetryLoad={() => void tasksQuery.refetch()}
          selectedSource={source ?? null}
          onSelectSource={setSourceFilter}
          selectedTaskId={taskFilter}
          onSelectTask={setTaskFilter}
        />
      </div>

      <div>
        <Card padded={false} className="p-2" id="bill-inbox-queue" role="tabpanel" aria-label={INBOX_VIEW_LABELS[view]}>
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2 px-2 pt-1">
            <div className="flex items-center gap-2">
              {selectable && (
                <input
                  type="checkbox"
                  aria-label={`全选${INBOX_VIEW_LABELS[view]}流水`}
                  checked={allSelected}
                  ref={(element) => {
                    if (element) element.indeterminate = !allSelected && someSelected
                  }}
                  onChange={toggleSelectAll}
                  disabled={selectableIds.length === 0}
                  className="shrink-0"
                />
              )}
              <h2 className="text-[13px] font-semibold text-[var(--text-primary)]">
                {INBOX_VIEW_LABELS[view]} <span className="num">{rows.length}</span> 笔
              </h2>
              {aiSuggestedCount > 0 && (
                <span className="text-[11.5px] text-[var(--text-secondary)]">
                  其中 <span className="num">{aiSuggestedCount}</span> 笔带 AI 建议
                </span>
              )}
              {(taskFilter !== null || source !== undefined) && (
                <span className="flex items-center gap-1.5 text-[11.5px] text-[var(--text-secondary)]">
                  {taskFilter !== null
                    ? `只看：${selectedTaskLabel ?? '这封邮件'}`
                    : `只看：${channelName(source ?? '')}`}
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="text-[var(--brand-text)] underline-offset-2 hover:underline"
                  >
                    看全部
                  </button>
                </span>
              )}
            </div>
            {view === 'importable' && selectableIds.length > 0 && (
              <Button
                variant="primary"
                size="sm"
                disabled={importMutation.isPending}
                onClick={() => void handleImport(primaryImportIds)}
              >
                {importMutation.isPending ? '入账中…' : `入账 ${primaryImportIds.length} 笔`}
              </Button>
            )}
          </div>

          {rowsQuery.isLoading ? (
            <ListSkeleton label={`${INBOX_VIEW_LABELS[view]}流水加载中`} />
          ) : rowsQuery.isError ? (
            <ErrorState message="流水加载失败" error={rowsQuery.error} onRetry={() => void rowsQuery.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState compact statusIcon="inbox" {...emptyStateFor(view, { onSync: () => void handleSync(), onGoImportable: () => setView('importable') })} />
          ) : view === 'attention' ? (
            <div className="flex flex-col gap-3">
              {attentionSections.map((section) => (
                <div key={section.kind} className="flex flex-col">
                  <h3 className="px-2 py-1 text-[11px] font-medium tracking-wide text-[var(--text-tertiary)] uppercase">
                    {section.label} <span className="num">{section.rows.length}</span>
                  </h3>
                  {section.rows.map((row) => (
                    <QueueRow
                      key={row.id}
                      {...rowProps(row, cursorRows.findIndex((candidate) => candidate.id === row.id))}
                      attentionKind={section.kind}
                    />
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col">
              {dayGroups.map((group) => (
                <div key={group.day} className="flex flex-col">
                  {/*
                    日期分组头：粘在顶部条下沿，带当日笔数与合计。
                    合计和每行金额右对齐在同一根线上 —— 一天花了多少，扫过去就有数。
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
                    <span className="num ml-auto pr-[calc(0.5rem+104px)] text-[11.5px] text-[var(--text-secondary)]">
                      {group.net === 0 ? '' : `${group.net < 0 ? '-' : '+'}${currencySymbol}${formatAmount(Math.abs(group.net).toFixed(2))}`}
                    </span>
                  </div>
                  {group.rows.map((row) => (
                    <QueueRow
                      key={row.id}
                      {...rowProps(row, cursorRows.findIndex((candidate) => candidate.id === row.id))}
                    />
                  ))}
                </div>
              ))}
            </div>
          )}

          {/* 滚动加载：到底了要明说共多少笔，不留「是不是还有」的悬念 */}
          {view !== 'attention' && rows.length > 0 && (
            <div ref={sentinelRef} className="px-2 pt-3 pb-1 text-center text-[11.5px] text-[var(--text-tertiary)]">
              {visibleRows.length < rows.length
                ? `正在加载…已显示 ${visibleRows.length} / ${rows.length} 笔`
                : `到底了 · 共 ${rows.length} 笔`}
            </div>
          )}

          {selectable && rows.length > 0 && (
            <p className="px-2 pt-2 pb-1 text-[11.5px] text-[var(--text-tertiary)]">
              键盘：j/k 上下 · x 勾选 · e 编辑 · d 忽略 · Enter 入账所选
            </p>
          )}
        </Card>
      </div>

      {/* 批量操作栏：选中就吸底出现，动词开头带数量 */}
      {selectedCount > 0 && (
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center p-4">
          <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-lg bg-[var(--surface-2)] px-3 py-2 shadow-[var(--shadow-pop)] ring-1 ring-[var(--border-subtle)]">
            <span className="text-[12.5px] text-[var(--text-primary)]">
              已选 <span className="num">{selectedCount}</span> 笔
            </span>
            <Button
              variant="primary"
              size="sm"
              disabled={importMutation.isPending}
              onClick={() => void handleImport(Array.from(selected))}
            >
              {importMutation.isPending ? '入账中…' : `入账 ${selectedCount} 笔`}
            </Button>
            <Button
              variant="ghost-danger"
              size="sm"
              disabled={dismissMutation.isPending}
              onClick={() => void handleDismiss(Array.from(selected))}
            >
              忽略 {selectedCount} 笔
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
              取消
            </Button>
          </div>
        </div>
      )}

      <ImportConfirmDialog
        open={dryRun !== null}
        title={`确认入账 ${confirmRowIds.length} 笔`}
        dryRun={dryRun}
        pending={importMutation.isPending}
        onCancel={() => {
          setDryRun(null)
          setConfirmRowIds([])
        }}
        onConfirm={() => void handleConfirmImport()}
      />

      <BillInboxSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}

/**
 * 工作量条：这一批有多少笔、进出各多少、最早一笔积压多久、这一趟清掉多少。
 *
 * 原来页头只有一个「114 笔」，看不出该不该现在动手：一百多笔全是几块钱的早餐，
 * 和一百多笔里压着一笔一万八的工资，是两件事。支出收入分开印，就是因为
 * 一笔工资能把四十笔小额支出的净额盖掉。
 */
function Workload({
  count,
  expense,
  income,
  earliestDay,
  today,
  symbol,
  handled,
}: {
  count: number
  expense: number
  income: number
  earliestDay: string | null
  today: string
  symbol: string
  handled: number
}) {
  const total = count + handled
  const percent = total === 0 ? 0 : Math.round((handled / total) * 100)
  const backlog = earliestDay ? relativeDayLabel(earliestDay, today) : null

  return (
    <Card padded={false} className="flex flex-wrap items-center gap-x-8 gap-y-3 px-4 py-3">
      <Stat label="待处理" value={`${count}`} unit="笔" />
      <Stat label="支出" value={`-${symbol}${formatAmount(expense.toFixed(2))}`} tone="danger" />
      <Stat label="收入" value={`+${symbol}${formatAmount(income.toFixed(2))}`} tone="done" />
      {earliestDay && (
        <Stat label="最早一笔" value={formatMonthDay(earliestDay)} unit={backlog ?? undefined} />
      )}
      <div className="flex min-w-[170px] flex-1 flex-col gap-1.5">
        <div className="flex justify-between text-[11px] text-[var(--text-tertiary)]">
          <span>本次已处理 <span className="num">{handled}</span> / <span className="num">{total}</span></span>
          <span className="num">{percent}%</span>
        </div>
        <div className="h-[5px] overflow-hidden rounded-full bg-[var(--surface-hover)]">
          <div className="h-full rounded-full bg-[var(--brand)] transition-[width] duration-300" style={{ width: `${percent}%` }} />
        </div>
      </div>
    </Card>
  )
}

function Stat({
  label,
  value,
  unit,
  tone,
}: {
  label: string
  value: string
  unit?: string
  tone?: 'danger' | 'done'
}) {
  const toneClass = tone === 'danger'
    ? 'text-[var(--danger)]'
    : tone === 'done'
      ? 'text-[var(--done)]'
      : 'text-[var(--text-primary)]'
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] text-[var(--text-tertiary)]">{label}</span>
      <span className={`num text-[17px] font-semibold ${toneClass}`}>
        {value}
        {unit && <span className="ml-1 text-[11.5px] font-normal text-[var(--text-secondary)]">{unit}</span>}
      </span>
    </div>
  )
}

/** 空状态得回答「我现在该干嘛」，四个 tab 各有各的下一步（文案规范 §空状态） */
function emptyStateFor(
  view: InboxView,
  actions: { onSync: () => void; onGoImportable: () => void },
): { message: string; action: { label: string; onClick: () => void } } {
  if (view === 'importable') {
    return { message: '没有待入账的流水', action: { label: '同步邮件', onClick: actions.onSync } }
  }
  if (view === 'attention') {
    return { message: '没有待确认的流水', action: { label: '看待入账的', onClick: actions.onGoImportable } }
  }
  if (view === 'dismissed') {
    return { message: '还没有忽略过流水', action: { label: '看待入账的', onClick: actions.onGoImportable } }
  }
  return { message: '还没有入账过流水', action: { label: '看待入账的', onClick: actions.onGoImportable } }
}

function ListSkeleton({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-1 p-2" role="status" aria-label={label}>
      {Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="h-8" />)}
    </div>
  )
}
