import { useMemo } from 'react'
import {
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  autocompleteAccounts,
  autocompleteCategories,
  autocompleteTags,
  autocompleteTransactions,
  archiveBillTask,
  createAccount,
  createCategory,
  updateCategory,
  deleteCategory,
  getCategoryStats,
  getBudgetGroups,
  setGroupBudget,
  createTransactionAttachment,
  createTransaction,
  createTransactionSplits,
  cleanupBillInbox,
  countTransactions,
  deleteTransaction,
  deleteBillTask,
  deleteAccount,
  deleteAttachment,
  deleteBudget,
  getAbout,
  getAllTransactions,
  getAccount,
  getAccountOverviewChart,
  getAccountsByType,
  getApiTokens,
  getAccountTransactions,
  getAssetAccounts,
  getBillInboxSummary,
  getBillInboxSettings,
  getBillTaskArtifacts,
  getBillTaskEvents,
  getBillTaskReview,
  getAllBillTasks,
  getBillTaskRows,
  getAllBillRows,
  getBillRows,
  dismissBillRows,
  restoreBillRows,
  importBillRows,
  getNetWorthAccounts,
  createBudget,
  createBudgetLimit,
  createBudgetWithLimit,
  getBudgetLimits,
  getBudgets,
  getCategories,
  getCurrencies,
  getExpenseByAsset,
  getExpenseByBudget,
  getExpenseByCategory,
  getExpenseByTag,
  getExpenseWithoutBudget,
  getExpenseWithoutCategory,
  getIncomeByRevenue,
  getFinancialReport,
  getRecurrences,
  getSummaryBasic,
  getTags,
  getTransaction,
  getTransactions,
  getTransactionAttachments,
  ignoreBillTask,
  importBillTaskRows,
  processBillInbox,
  retryBillTask,
  revokeApiToken,
  searchTransactions,
  searchAccounts,
  submitBillTaskSecret,
  syncBillInbox,
  splitBillStatementRow,
  updateBillInboxSettings,
  markBillRowUnique,
  updateBillStatementRow,
  updateBudget,
  updateBudgetLimit,
  updateTransaction,
  updateTransactionSplits,
  triggerRecurrence,
  updateAccount,
  updateAttachment,
  type AccountChartPreselected,
  type AccountOverviewChartOpts,
  type AccountInput,
  type AccountType,
  type CreateTransactionInput,
  type DateRange,
  type TransactionTypeFilter,
  type UpdateBillStatementRowInput,
  type UpdateTransactionInput,
  type BillInboxSettingsInput,
  type CategoryWriteInput,
} from './firefly'
import {
  actVocabSuggestion,
  deleteCategoryRule,
  getBackfillSuggestions,
  getCategoryRules,
  getVocabSuggestions,
  postCategoryFeedback,
  resolveBackfillSuggestion,
  runBackfill,
  updateCategoryRule,
  type CategoryFeedbackInput,
} from './assistant'
import type { BillRowGroup, BillRowsResponse } from './schemas'
import { CONFIRMED, DRY_RUN } from './gate'
import { getCatalog, indexCapabilities, type Capability } from './catalog'
import { hasActiveToken } from './client'
import { useDateRangeStore } from '../store/dateRangeStore'

/** 依赖全局日期范围的查询：等 preferences hydrate 后再发，避免冷启动默认近30天双发 */
function useDateRangeReady(extraEnabled = true): boolean {
  const hydrated = useDateRangeStore((s) => s.hydrated)
  return hydrated && extraEnabled
}

export function useSummaryBasic(range: DateRange, opts: { enabled?: boolean } = {}) {
  const ready = useDateRangeReady(opts.enabled ?? true)
  return useQuery({
    queryKey: ['summary-basic', range.start, range.end],
    queryFn: () => getSummaryBasic(range),
    enabled: ready,
  })
}

export function useTransactions(
  range: DateRange,
  opts: { limit?: number; page?: number; type?: TransactionTypeFilter; enabled?: boolean } = {},
) {
  const ready = useDateRangeReady(opts.enabled ?? true)
  return useQuery({
    queryKey: ['transactions', range.start, range.end, opts.limit, opts.page, opts.type],
    queryFn: () => getTransactions(range, opts),
    enabled: ready,
  })
}

export function useAllTransactions(
  range: DateRange,
  opts: { limit?: number; type?: TransactionTypeFilter; enabled?: boolean } = {},
) {
  const ready = useDateRangeReady(opts.enabled ?? true)
  return useQuery({
    queryKey: ['transactions', 'all-pages', range.start, range.end, opts.limit, opts.type],
    queryFn: () => getAllTransactions(range, opts),
    enabled: ready,
  })
}

/** 命令面板「搜索交易」区：调用方负责按查询长度/防抖决定 enabled（见 CommandPalette）。 */
export function useSearchTransactions(query: string, opts: { enabled: boolean }) {
  return useQuery({
    queryKey: ['search-transactions', query],
    queryFn: () => searchTransactions(query, 10),
    enabled: opts.enabled,
    staleTime: 30_000,
  })
}

export function useSearchTransactionCount(query: string, opts: { enabled: boolean }) {
  return useQuery({
    queryKey: ['search-transaction-count', query],
    queryFn: () => countTransactions(query),
    enabled: opts.enabled,
    staleTime: 30_000,
  })
}

/** 交易工作台：分页搜索（筛选条件编译成查询语言，走 /search/transactions）。 */
export function useSearchTransactionsPage(
  query: string,
  opts: { limit?: number; page?: number; enabled?: boolean } = {},
) {
  const ready = useDateRangeReady(opts.enabled ?? true)
  return useQuery({
    queryKey: ['search-transactions-page', query, opts.limit, opts.page],
    queryFn: () => searchTransactions(query, opts.limit ?? 50, opts.page ?? 1),
    enabled: ready && query.trim().length > 0,
    staleTime: 30_000,
  })
}

/**
 * 交易工作台：滚动加载。底部翻页换成往下续，光标位置不会因为翻页被打断，
 * 一次整理几百笔时不用记住自己在第几页。
 */
export function useInfiniteSearchTransactions(
  query: string,
  opts: { limit?: number; enabled?: boolean } = {},
) {
  const ready = useDateRangeReady(opts.enabled ?? true)
  const limit = opts.limit ?? 50
  return useInfiniteQuery({
    queryKey: ['search-transactions-page', 'infinite', query, limit],
    queryFn: ({ pageParam }) => searchTransactions(query, limit, pageParam),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => {
      const pagination = lastPage.meta?.pagination
      if (!pagination) return undefined
      const current = pagination.current_page ?? 1
      const total = pagination.total_pages ?? 1
      return current < total ? current + 1 : undefined
    },
    enabled: ready && query.trim().length > 0,
    staleTime: 30_000,
  })
}

/**
 * 批量改分类/预算/标签：后端没有批量端点，逐笔 PUT，失败不中断并汇总报错。
 * ponytail: 需要原子性/性能时再给 Firefly 加 POST /data/bulk/transactions。
 */
export function useBulkEditTransactions() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (updates: Array<{ groupId: string; input: UpdateTransactionInput }>) => {
      const failed: string[] = []
      for (const { groupId, input } of updates) {
        try {
          await updateTransaction(groupId, input)
        } catch {
          failed.push(groupId)
        }
      }
      if (failed.length > 0) {
        throw new Error(`部分交易更新失败（${failed.length} 笔，共 ${updates.length} 笔），已成功的不会回滚`)
      }
    },
    onSuccess: () => invalidateTransactionCaches(queryClient),
  })
}

export function useSearchAccounts(query: string, opts: { enabled: boolean }) {
  return useQuery({
    queryKey: ['search-accounts', query],
    queryFn: () => searchAccounts(query),
    enabled: opts.enabled,
    staleTime: 30_000,
  })
}

export function useExpenseByCategory(range: DateRange, opts: { enabled?: boolean } = {}) {
  const ready = useDateRangeReady(opts.enabled ?? true)
  return useQuery({
    queryKey: ['expense-by-category', range.start, range.end],
    queryFn: () => getExpenseByCategory(range),
    enabled: ready,
  })
}

/** 报表页「收入来源排行」 */
export function useIncomeByRevenue(range: DateRange, opts: { enabled?: boolean } = {}) {
  const ready = useDateRangeReady(opts.enabled ?? true)
  return useQuery({
    queryKey: ['income-by-revenue', range.start, range.end],
    queryFn: () => getIncomeByRevenue(range),
    enabled: ready,
  })
}

/** 报表页「账户流出排行」 */
export function useExpenseByAsset(range: DateRange, opts: { enabled?: boolean } = {}) {
  const ready = useDateRangeReady(opts.enabled ?? true)
  return useQuery({
    queryKey: ['expense-by-asset', range.start, range.end],
    queryFn: () => getExpenseByAsset(range),
    enabled: ready,
  })
}

function useInsightRanking(key: string, range: DateRange, queryFn: () => ReturnType<typeof getExpenseByTag>, enabled = true) {
  const ready = useDateRangeReady(enabled)
  return useQuery({ queryKey: [key, range.start, range.end], queryFn, enabled: ready })
}

export function useExpenseByTag(range: DateRange, opts: { enabled?: boolean } = {}) {
  return useInsightRanking('expense-by-tag', range, () => getExpenseByTag(range), opts.enabled ?? true)
}

export function useExpenseByBudget(range: DateRange, opts: { enabled?: boolean } = {}) {
  return useInsightRanking('expense-by-budget', range, () => getExpenseByBudget(range), opts.enabled ?? true)
}

export function useExpenseWithoutCategory(range: DateRange, opts: { enabled?: boolean } = {}) {
  return useInsightRanking('expense-without-category', range, () => getExpenseWithoutCategory(range), opts.enabled ?? true)
}

export function useExpenseWithoutBudget(range: DateRange, opts: { enabled?: boolean } = {}) {
  return useInsightRanking('expense-without-budget', range, () => getExpenseWithoutBudget(range), opts.enabled ?? true)
}

export function useFinancialReport(range: DateRange, opts: { enabled?: boolean } = {}) {
  const ready = useDateRangeReady(opts.enabled ?? true)
  return useQuery({
    queryKey: ['financial-report', range.start, range.end],
    queryFn: () => getFinancialReport(range),
    enabled: ready,
  })
}

/**
 * 总览 / 账户详情：账户余额时间序列。
 * opts.accounts 有值时按 id 拉单账户或多账户；否则 preselected 默认 assets。
 */
export function useAccountOverviewChart(
  range: DateRange,
  opts: AccountOverviewChartOpts & { enabled?: boolean } = {},
) {
  const ready = useDateRangeReady(opts.enabled ?? true)
  const accountKey = opts.accounts?.join(',') ?? ''
  const preselected: AccountChartPreselected | 'empty' =
    opts.accounts && opts.accounts.length > 0 ? 'empty' : (opts.preselected ?? 'assets')
  return useQuery({
    queryKey: [
      'chart-account-overview',
      range.start,
      range.end,
      opts.period ?? 'auto',
      preselected,
      accountKey,
    ],
    queryFn: () => getAccountOverviewChart(range, opts),
    enabled: ready,
    staleTime: 60_000,
  })
}

export function useBillInboxSummary() {
  return useQuery({
    queryKey: ['bill-inbox-summary'],
    queryFn: () => getBillInboxSummary(),
    staleTime: 60_000,
  })
}

export function useBillInboxSettings(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['bill-inbox-settings'],
    queryFn: () => getBillInboxSettings(),
    enabled: opts.enabled ?? true,
  })
}

function invalidateBillInbox(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ['bill-inbox-summary'] })
  queryClient.invalidateQueries({ queryKey: ['bill-rows'] })
  queryClient.invalidateQueries({ queryKey: ['bill-tasks'] })
  queryClient.invalidateQueries({ queryKey: ['bill-task-rows'] })
  queryClient.invalidateQueries({ queryKey: ['bill-task-review'] })
  queryClient.invalidateQueries({ queryKey: ['bill-task-events'] })
  queryClient.invalidateQueries({ queryKey: ['bill-task-artifacts'] })
}

export function useUpdateBillInboxSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: BillInboxSettingsInput) => updateBillInboxSettings(input),
    onSuccess: (data) => queryClient.setQueryData(['bill-inbox-settings'], data),
  })
}

export function useProcessBillInbox() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (limit?: number) => processBillInbox(limit),
    onSuccess: () => invalidateBillInbox(queryClient),
  })
}

export function useCleanupBillInbox() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => cleanupBillInbox(),
    onSuccess: () => invalidateBillInbox(queryClient),
  })
}

/**
 * GET /api/v1/bill-rows —— 收件箱队列的主数据源。
 * group 一次只读一组：三组各自的分页、空态、加载态互不牵连。
 */
export function useBillRows(group: BillRowGroup, opts: { source?: string; enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['bill-rows', group, opts.source ?? 'all'],
    queryFn: () => getAllBillRows({ group, source: opts.source }),
    enabled: opts.enabled ?? true,
    staleTime: 15_000,
  })
}

/**
 * 状态 tab 上的数字（待入账 N / 待确认 N / 已忽略 N / 已入账 N）。
 * 只取 meta 的总数，不把整组行拉下来——没打开的 tab 不值这个流量。
 */
export function useBillRowsCount(group: BillRowGroup, opts: { source?: string } = {}) {
  return useQuery({
    queryKey: ['bill-rows', 'count', group, opts.source ?? 'all'],
    queryFn: () => getBillRows({ group, source: opts.source, page: 1, limit: 1 }),
    select: (response) => response.meta?.pagination?.total ?? response.data.length,
    staleTime: 30_000,
  })
}

/**
 * 顶部渠道条上每个渠道的笔数。和上面那个共用 queryKey，选中某个渠道时
 * 两边命中同一份缓存，不会多发一次请求。
 */
export function useBillRowsCountByChannel(group: BillRowGroup, channelKeys: string[]) {
  return useQueries({
    queries: channelKeys.map((key) => ({
      queryKey: ['bill-rows', 'count', group, key],
      queryFn: () => getBillRows({ group, source: key, page: 1, limit: 1 }),
      select: (response: BillRowsResponse) => response.meta?.pagination?.total ?? response.data.length,
      staleTime: 30_000,
    })),
  })
}

export function useDismissBillRows() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: { row_ids: string[] } | { filter: 'machine_duplicates' }) => dismissBillRows(body),
    onSuccess: () => invalidateBillInbox(queryClient),
  })
}

export function useRestoreBillRows() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (rowIds: string[]) => restoreBillRows(rowIds),
    onSuccess: () => invalidateBillInbox(queryClient),
  })
}

/** 跨任务批量入账。干跑（confirm:false）不动缓存，正式入账才失效。 */
export function useImportBillRows() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ rowIds, confirm }: { rowIds: string[]; confirm: boolean }) =>
      importBillRows({ row_ids: rowIds, confirm }),
    onSuccess: (_data, variables) => {
      if (!variables.confirm) return
      invalidateBillInbox(queryClient)
      invalidateTransactionCaches(queryClient)
    },
  })
}

/** 今天页资产卡：资产 / 负债 / 净资产三数 + 账本最后一笔 */
export function useNetWorthAccounts() {
  return useQuery({
    queryKey: ['accounts', 'net-worth'],
    queryFn: () => getNetWorthAccounts(),
    staleTime: 60_000,
  })
}

/**
 * 任务列表接口每次只接受单个 status 值（数组/逗号写法后端会 500），
 * 「需处理」这类合并了多个 status 的 tab 用 useQueries 并发读取每个 status 的
 * 全部分页，再由调用方合并排序。
 */
export function useBillTasksByStatuses(
  statuses: string[],
  opts: { source?: string },
) {
  return useQueries({
    queries: statuses.map((status) => ({
      queryKey: ['bill-tasks', 'all-pages', opts.source ?? 'all', status],
      queryFn: () => getAllBillTasks({ source: opts.source, status }),
      staleTime: 15_000,
    })),
  })
}

/**
 * 来源面板要的是「这个收件箱里有哪些邮件」，一次全拿，不按状态拆：
 * 按状态拆成 7 个并发请求只为了在前端再拼回一个列表，纯属绕路。
 */
export function useBillTasks(opts: { source?: string; enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['bill-tasks', 'all-pages', opts.source ?? 'all', 'any-status'],
    queryFn: () => getAllBillTasks({ source: opts.source }),
    enabled: opts.enabled ?? true,
    staleTime: 15_000,
  })
}

export function useBillTaskRows(taskId: string | null, status?: string) {
  return useQuery({
    queryKey: ['bill-task-rows', taskId, status ?? 'all'],
    queryFn: () => getBillTaskRows(taskId as string, { status }),
    enabled: !!taskId,
    staleTime: 15_000,
  })
}

export function useBillTaskArtifacts(taskId: string | null) {
  return useQuery({
    queryKey: ['bill-task-artifacts', taskId],
    queryFn: () => getBillTaskArtifacts(taskId as string),
    enabled: !!taskId,
  })
}

export function useBillTaskEvents(taskId: string | null) {
  return useQuery({
    queryKey: ['bill-task-events', taskId],
    queryFn: () => getBillTaskEvents(taskId as string),
    enabled: !!taskId,
  })
}

export function useBillTaskReview(taskId: string | null) {
  return useQuery({
    queryKey: ['bill-task-review', taskId],
    queryFn: () => getBillTaskReview(taskId as string),
    enabled: !!taskId,
  })
}

function invalidateBillRow(queryClient: ReturnType<typeof useQueryClient>, taskId: string): void {
  queryClient.invalidateQueries({ queryKey: ['bill-task-rows', taskId] })
  queryClient.invalidateQueries({ queryKey: ['bill-task-review', taskId] })
  queryClient.invalidateQueries({ queryKey: ['bill-tasks'] })
  queryClient.invalidateQueries({ queryKey: ['bill-rows'] })
  queryClient.invalidateQueries({ queryKey: ['bill-inbox-summary'] })
}

/**
 * PATCH /v1/rows/{id}：填一条流水该记成什么。
 *
 * 服务端强制 `as_suggestion: true`——从这里写进去的一律是建议，行上会带 `suggested_by`，
 * 页面得把它显示成「等你确认」（见 QueueRow 的建议标记）。银行原文不在可写字段里。
 */
export function useUpdateBillStatementRow() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ rowId, input }: { rowId: string; input: UpdateBillStatementRowInput }) =>
      updateBillStatementRow(rowId, input),
    onSuccess: (res) => invalidateBillRow(queryClient, String(res.data.attributes.bill_task_id)),
  })
}

/** 改判「不是重复」。duplicate_state 还没进 rows.update，走逃生舱。 */
export function useMarkBillRowUnique() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (rowId: string) => markBillRowUnique(rowId),
    onSuccess: (res) => invalidateBillRow(queryClient, String(res.data.attributes.bill_task_id)),
  })
}

export function useSplitBillStatementRow() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      rowId,
      splits,
    }: {
      rowId: string
      splits: Array<{ payment_method?: string; source_name?: string; amount: string; description: string; category_name?: string }>
    }) => splitBillStatementRow(rowId, splits),
    onSuccess: (response) => {
      const taskId = String(response.parent.attributes.bill_task_id)
      queryClient.invalidateQueries({ queryKey: ['bill-task-rows', taskId] })
      queryClient.invalidateQueries({ queryKey: ['bill-task-review', taskId] })
      queryClient.invalidateQueries({ queryKey: ['bill-tasks'] })
      queryClient.invalidateQueries({ queryKey: ['bill-rows'] })
      queryClient.invalidateQueries({ queryKey: ['bill-inbox-summary'] })
    },
  })
}

/**
 * 干跑与正式入账复用同一 mutation。
 *
 * `bills.import` 是 confirm 档：`confirm:false` 走 `dry_run=true` 拿预览（不落库），
 * `confirm:true` 走 `confirm=true` 真入账。两个都不带服务端直接 409，页面绕不过这一步。
 */
export function useImportBillTaskRows() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ taskId, rowIds, all, confirm }: { taskId: string; rowIds?: string[]; all?: boolean; confirm: boolean }) =>
      importBillTaskRows(taskId, { row_ids: rowIds, all }, confirm ? CONFIRMED : DRY_RUN),
    onSuccess: (_data, variables) => {
      if (!variables.confirm) return
      // 只在正式入账（非干跑）后才需要让相关缓存失效
      queryClient.invalidateQueries({ queryKey: ['bill-inbox-summary'] })
      queryClient.invalidateQueries({ queryKey: ['bill-rows'] })
      queryClient.invalidateQueries({ queryKey: ['bill-tasks'] })
      queryClient.invalidateQueries({ queryKey: ['bill-task-rows', variables.taskId] })
      queryClient.invalidateQueries({ queryKey: ['bill-task-review', variables.taskId] })
      queryClient.invalidateQueries({ queryKey: ['bill-task-events', variables.taskId] })
      invalidateTransactionCaches(queryClient)
    },
  })
}

/**
 * `bills.ignore` 是 confirm 档：`confirm:false` 只拿一句「将要忽略这份账单」的预览，
 * `confirm:true` 才真忽略。干跑不改数据，所以不刷缓存。
 */
export function useIgnoreBillTask() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ taskId, confirm }: { taskId: string; confirm: boolean }) =>
      ignoreBillTask(taskId, confirm ? CONFIRMED : DRY_RUN),
    onSuccess: (_data, variables) => {
      if (!variables.confirm) return
      invalidateBillInbox(queryClient)
    },
  })
}

export function useArchiveBillTask() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (taskId: string) => archiveBillTask(taskId),
    onSuccess: () => invalidateBillInbox(queryClient),
  })
}

export function useDeleteBillTask() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (taskId: string) => deleteBillTask(taskId),
    onSuccess: () => invalidateBillInbox(queryClient),
  })
}

/** 邮箱同步：成功后刷新徽标与任务列表（红线：勿在 UI 上自动轮询触发） */
export function useSyncBillInbox() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (opts?: { limit?: number }) => syncBillInbox(opts ?? {}),
    onSuccess: () => invalidateBillInbox(queryClient),
  })
}

/**
 * `bills.unlock` 是 confirm 档。干跑**不会把密码递给上游**——服务端在预览分支里就返回了，
 * 所以密码得是人当场敲的那一份，两步用的是同一个输入框里的值，不缓存、不留存。
 */
export function useSubmitBillTaskSecret() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ taskId, value, confirm }: { taskId: string; value: string; confirm: boolean }) =>
      submitBillTaskSecret(taskId, value, confirm ? CONFIRMED : DRY_RUN),
    onSuccess: (_data, variables) => {
      if (!variables.confirm) return
      queryClient.invalidateQueries({ queryKey: ['bill-inbox-summary'] })
      queryClient.invalidateQueries({ queryKey: ['bill-tasks'] })
      queryClient.invalidateQueries({ queryKey: ['bill-task-rows', variables.taskId] })
      queryClient.invalidateQueries({ queryKey: ['bill-task-review', variables.taskId] })
      queryClient.invalidateQueries({ queryKey: ['bill-task-events', variables.taskId] })
      queryClient.invalidateQueries({ queryKey: ['bill-task-artifacts', variables.taskId] })
    },
  })
}

export function useRetryBillTask() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (taskId: string) => retryBillTask(taskId),
    onSuccess: () => invalidateBillInbox(queryClient),
  })
}

/** 记一笔表单的资产(+负债)账户下拉；对账调整传 includeLiabilities:false */
export function useAssetAccounts(opts: { includeLiabilities?: boolean } = {}) {
  const includeLiabilities = opts.includeLiabilities ?? true
  return useQuery({
    queryKey: ['accounts', 'asset', includeLiabilities ? 'with-liab' : 'pure'],
    queryFn: () => getAssetAccounts({ includeLiabilities }),
    staleTime: 5 * 60_000,
  })
}

/** GET /api/v1/accounts/{id} —— 账户详情页头信息 */
export function useAccount(accountId: string | null) {
  return useQuery({
    queryKey: ['account', accountId],
    queryFn: () => getAccount(accountId as string),
    enabled: !!accountId,
    staleTime: 60_000,
  })
}

function invalidateAccountCaches(queryClient: ReturnType<typeof useQueryClient>) {
  invalidateTransactionCaches(queryClient)
}

export function useCreateAccount() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: AccountInput) => createAccount(input),
    onSuccess: () => invalidateAccountCaches(queryClient),
  })
}

export function useUpdateAccount() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ accountId, input }: { accountId: string; input: AccountInput }) => updateAccount(accountId, input),
    onSuccess: () => invalidateAccountCaches(queryClient),
  })
}

export function useDeleteAccount() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (accountId: string) => deleteAccount(accountId),
    onSuccess: () => invalidateAccountCaches(queryClient),
  })
}

/**
 * GET /api/v1/accounts/{id}/transactions —— 账户详情无限滚动。
 * 用 useInfiniteQuery 派生 pages，避免手动 loaded append 在 invalidate/refetch 时重复累加。
 */
export function useInfiniteAccountTransactions(
  accountId: string | null,
  range: DateRange,
  opts: { limit?: number; type?: TransactionTypeFilter; enabled?: boolean } = {},
) {
  const ready = useDateRangeReady((opts.enabled ?? true) && !!accountId)
  const limit = opts.limit ?? 50
  const type = opts.type ?? 'all'
  return useInfiniteQuery({
    queryKey: ['account-transactions', accountId, range.start, range.end, limit, type],
    queryFn: ({ pageParam }) =>
      getAccountTransactions(accountId as string, range, {
        limit,
        beforeId: pageParam,
        type: opts.type,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.next_before_id ?? undefined,
    enabled: ready,
  })
}

/** 交易写操作成功后统一失效的 queryKey 范围 */
function invalidateTransactionCaches(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ['transactions'] })
  queryClient.invalidateQueries({ queryKey: ['transaction'] })
  queryClient.invalidateQueries({ queryKey: ['summary-basic'] })
  queryClient.invalidateQueries({ queryKey: ['expense-by-category'] })
  queryClient.invalidateQueries({ queryKey: ['income-by-revenue'] })
  queryClient.invalidateQueries({ queryKey: ['expense-by-asset'] })
  queryClient.invalidateQueries({ queryKey: ['expense-by-tag'] })
  queryClient.invalidateQueries({ queryKey: ['expense-by-budget'] })
  queryClient.invalidateQueries({ queryKey: ['expense-without-category'] })
  queryClient.invalidateQueries({ queryKey: ['expense-without-budget'] })
  queryClient.invalidateQueries({ queryKey: ['financial-report'] })
  queryClient.invalidateQueries({ queryKey: ['search-transactions'] })
  // 交易页分页列表用的是 search-transactions-page，前缀跟 search-transactions 不同，
  // 少这一行批量改分类/删除之后列表不会刷新。
  queryClient.invalidateQueries({ queryKey: ['search-transactions-page'] })
  queryClient.invalidateQueries({ queryKey: ['search-transaction-count'] })
  queryClient.invalidateQueries({ queryKey: ['search-accounts'] })
  queryClient.invalidateQueries({ queryKey: ['autocomplete-transactions'] })
  queryClient.invalidateQueries({ queryKey: ['autocomplete-accounts'] })
  queryClient.invalidateQueries({ queryKey: ['autocomplete-categories'] })
  queryClient.invalidateQueries({ queryKey: ['autocomplete-tags'] })
  queryClient.invalidateQueries({ queryKey: ['categories'] })
  queryClient.invalidateQueries({ queryKey: ['tags'] })
  queryClient.invalidateQueries({ queryKey: ['chart-account-overview'] })
  queryClient.invalidateQueries({ queryKey: ['account-transactions'] })
  queryClient.invalidateQueries({ queryKey: ['account'] })
  queryClient.invalidateQueries({ queryKey: ['accounts'] })
  queryClient.invalidateQueries({ queryKey: ['budgets'] })
  queryClient.invalidateQueries({ queryKey: ['budget-limits'] })
}

/** 记一笔表单提交：成功后让交易列表/KPI/分类洞察缓存失效 */
export function useCreateTransaction() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateTransactionInput) => createTransaction(input),
    onSuccess: () => invalidateTransactionCaches(queryClient),
  })
}

export function useCreateTransactionSplits() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ inputs, groupTitle }: { inputs: CreateTransactionInput[]; groupTitle?: string }) =>
      createTransactionSplits(inputs, groupTitle),
    onSuccess: () => invalidateTransactionCaches(queryClient),
  })
}

/** GET /api/v1/transactions/{groupId}，编辑前可选拉详情 */
export function useTransaction(groupId: string | null) {
  return useQuery({
    queryKey: ['transaction', groupId],
    queryFn: () => getTransaction(groupId as string),
    enabled: !!groupId,
  })
}

export function useTransactionAttachments(groupId: string | null) {
  return useQuery({
    queryKey: ['transaction-attachments', groupId],
    queryFn: () => getTransactionAttachments(groupId as string),
    enabled: !!groupId,
  })
}

export function useCreateTransactionAttachment() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: createTransactionAttachment,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['transaction-attachments'] }),
  })
}

export function useUpdateAttachment() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ attachmentId, input }: { attachmentId: string; input: { filename?: string; title?: string; notes?: string } }) => updateAttachment(attachmentId, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['transaction-attachments'] }),
  })
}

export function useDeleteAttachment() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: deleteAttachment,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['transaction-attachments'] }),
  })
}

export function useUpdateTransaction() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ groupId, input }: { groupId: string; input: UpdateTransactionInput }) =>
      updateTransaction(groupId, input),
    onSuccess: () => invalidateTransactionCaches(queryClient),
  })
}

export function useUpdateTransactionSplits() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ groupId, inputs, groupTitle }: { groupId: string; inputs: UpdateTransactionInput[]; groupTitle?: string }) =>
      updateTransactionSplits(groupId, inputs, groupTitle),
    onSuccess: () => invalidateTransactionCaches(queryClient),
  })
}

export function useDeleteTransaction() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (groupId: string) => deleteTransaction(groupId),
    onSuccess: () => invalidateTransactionCaches(queryClient),
  })
}

export function useInfiniteAccountsByType(type: AccountType, opts: { limit?: number } = {}) {
  const limit = opts.limit ?? 40
  return useInfiniteQuery({
    queryKey: ['accounts', 'infinite', type, limit],
    queryFn: ({ pageParam }) => getAccountsByType(type, { limit, page: pageParam }),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => {
      const pagination = lastPage.meta?.pagination
      if (!pagination) return undefined
      const current = pagination.current_page ?? 1
      const total = pagination.total_pages ?? 1
      return current < total ? current + 1 : undefined
    },
    staleTime: 30_000,
  })
}

/** 预算与订阅页「预算」tab：用全局日期范围 store 计算当期已花费 */
export function useBudgets(range: DateRange, opts: { enabled?: boolean } = {}) {
  const ready = useDateRangeReady(opts.enabled ?? true)
  return useQuery({
    queryKey: ['budgets', range.start, range.end],
    queryFn: () => getBudgets(range),
    enabled: ready,
  })
}

/**
 * 每个预算各自的手动限额（0~1 条，通常按月设置）。budgetIds 为空时 useQueries 直接返回空数组，
 * 调用方按下标与 budgetIds 一一对应读取结果（同 useBudgetTasksByStatuses 的用法）。
 */
export function useBudgetLimits(budgetIds: string[], range: DateRange) {
  const ready = useDateRangeReady(budgetIds.length > 0)
  return useQueries({
    queries: budgetIds.map((id) => ({
      queryKey: ['budget-limits', id, range.start, range.end],
      queryFn: () => getBudgetLimits(id, range),
      staleTime: 60_000,
      enabled: ready,
    })),
  })
}

function invalidateBudgetCaches(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ['budgets'] })
  queryClient.invalidateQueries({ queryKey: ['budget-limits'] })
  queryClient.invalidateQueries({ queryKey: ['expense-by-budget'] })
  queryClient.invalidateQueries({ queryKey: ['expense-without-budget'] })
  queryClient.invalidateQueries({ queryKey: ['financial-report'] })
}

export function useCreateBudget() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { name: string; active?: boolean }) => createBudget(input),
    onSuccess: () => invalidateBudgetCaches(queryClient),
  })
}

export function useCreateBudgetWithLimit() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: createBudgetWithLimit,
    onSuccess: () => invalidateBudgetCaches(queryClient),
  })
}

export function useUpdateBudget() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ budgetId, input }: { budgetId: string; input: { name?: string; active?: boolean } }) =>
      updateBudget(budgetId, input),
    onSuccess: () => invalidateBudgetCaches(queryClient),
  })
}

export function useDeleteBudget() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: deleteBudget,
    onSuccess: () => invalidateBudgetCaches(queryClient),
  })
}

export function useCreateBudgetLimit() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      budgetId,
      input,
    }: {
      budgetId: string
      input: { start: string; end: string; amount: string; currency_code?: string }
    }) => createBudgetLimit(budgetId, input),
    onSuccess: () => invalidateBudgetCaches(queryClient),
  })
}

export function useUpdateBudgetLimit() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      budgetId,
      limitId,
      input,
    }: {
      budgetId: string
      limitId: string
      input: { amount: string; start?: string; end?: string }
    }) => updateBudgetLimit(budgetId, limitId, input),
    onSuccess: () => invalidateBudgetCaches(queryClient),
  })
}

/**
 * 分类词表：变动很少，缓存 5 分钟。
 * 不传参数是选择器口径（全部域、不含禁用）；管理页传 includeDisabled 才看得到禁用项。
 */
export function useCategories(params: { domain?: string; includeDisabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['categories', params.domain ?? 'all', params.includeDisabled ?? false],
    queryFn: () => getCategories(params),
    staleTime: 5 * 60_000,
  })
}

/** 分类用量：近一年笔数、最后使用时间、未分类交易笔数 */
export function useCategoryStats() {
  return useQuery({
    queryKey: ['category-stats'],
    queryFn: () => getCategoryStats(),
    staleTime: 60_000,
  })
}

/**
 * 词表写操作后统一失效的范围。
 * 分类名字/图标散落在交易行、选择器、洞察排行里，漏一个就会出现「已经改了名但那边还是旧的」。
 */
function invalidateCategoryCaches(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ['categories'] })
  queryClient.invalidateQueries({ queryKey: ['category-stats'] })
  queryClient.invalidateQueries({ queryKey: ['budget-groups'] })
  queryClient.invalidateQueries({ queryKey: ['autocomplete-categories'] })
  queryClient.invalidateQueries({ queryKey: ['reference-data'] })
  queryClient.invalidateQueries({ queryKey: ['expense-by-category'] })
  queryClient.invalidateQueries({ queryKey: ['expense-without-category'] })
  queryClient.invalidateQueries({ queryKey: ['vocab-suggestions'] })
}

export function useCreateCategory() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (attrs: CategoryWriteInput) => createCategory(attrs),
    onSuccess: () => invalidateCategoryCaches(queryClient),
  })
}

export function useUpdateCategory() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, attrs }: { id: string; attrs: CategoryWriteInput }) => updateCategory(id, attrs),
    onSuccess: () => invalidateCategoryCaches(queryClient),
  })
}

/**
 * 删分类。名下有交易时后端回 422，调用方接住再带 migrateTo 重试。
 * 迁移会动交易，所以连交易缓存一起失效。
 */
export function useDeleteCategory() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, migrateTo }: { id: string; migrateTo?: string }) => deleteCategory(id, migrateTo),
    onSuccess: () => {
      invalidateCategoryCaches(queryClient)
      invalidateTransactionCaches(queryClient)
    },
  })
}

/** 预算页「按组预算」：组预算的口径跟着日期范围走 */
export function useBudgetGroups(range: DateRange, opts: { enabled?: boolean } = {}) {
  const ready = useDateRangeReady(opts.enabled ?? true)
  return useQuery({
    queryKey: ['budget-groups', range.start, range.end],
    queryFn: () => getBudgetGroups(range.start, range.end),
    enabled: ready,
  })
}

export function useSetGroupBudget() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ categoryId, amount }: { categoryId: string; amount: string | null }) =>
      setGroupBudget(categoryId, amount),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['budget-groups'] })
      invalidateBudgetCaches(queryClient)
    },
  })
}

/* ---------- 分类引擎（abei-agent）：规则、反馈、回填、词表建议 ---------- */

/** 「已学会的规则」列表 */
export function useCategoryRules(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['category-rules'],
    queryFn: () => getCategoryRules(),
    enabled: opts.enabled ?? true,
    staleTime: 60_000,
  })
}

export function useUpdateCategoryRule() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => updateCategoryRule(id, enabled),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['category-rules'] }),
  })
}

export function useDeleteCategoryRule() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteCategoryRule(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['category-rules'] }),
  })
}

/** 纠正即学习：用户改掉 AI 建议的分类之后回报一次 */
export function useCategoryFeedback() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: CategoryFeedbackInput) => postCategoryFeedback(payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['category-rules'] }),
  })
}

/** 让 AI 给未分类交易出建议。409 表示后台已经在跑，调用方按「已经在跑」提示 */
export function useRunBackfill() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => runBackfill(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['backfill-suggestions'] }),
  })
}

export function useBackfillSuggestions(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['backfill-suggestions'],
    queryFn: () => getBackfillSuggestions(),
    enabled: opts.enabled ?? true,
    staleTime: 30_000,
  })
}

/** 采纳或丢弃一条回填建议。采纳会写分类，所以交易缓存一起失效 */
export function useResolveBackfillSuggestion() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ journalId, applied }: { journalId: string; applied: boolean }) =>
      resolveBackfillSuggestion(journalId, applied),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['backfill-suggestions'] })
      queryClient.invalidateQueries({ queryKey: ['category-stats'] })
      invalidateTransactionCaches(queryClient)
    },
  })
}

export function useVocabSuggestions(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['vocab-suggestions'],
    queryFn: () => getVocabSuggestions(),
    enabled: opts.enabled ?? true,
    staleTime: 60_000,
  })
}

/**
 * 回报词表建议的处置结果。
 * 同意的流程是「前端先落词表 → 成功了再回报 accept」，所以这个 hook 只管回报。
 */
export function useActVocabSuggestion() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'accept' | 'ignore' }) =>
      actVocabSuggestion(id, action),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['vocab-suggestions'] }),
  })
}

export function useTags() {
  return useQuery({
    queryKey: ['tags'],
    queryFn: () => getTags(),
    staleTime: 5 * 60_000,
  })
}

export function useTriggerRecurrence() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, date }: { id: string; date: string }) => triggerRecurrence(id, date),
    onSuccess: () => {
      invalidateTransactionCaches(queryClient)
      queryClient.invalidateQueries({ queryKey: ['recurrences'] })
    },
  })
}

export function useRecurrences() {
  return useQuery({
    queryKey: ['recurrences'],
    queryFn: () => getRecurrences(),
    staleTime: 60_000,
  })
}

export function useApiTokens() {
  return useQuery({
    queryKey: ['api-tokens'],
    queryFn: () => getApiTokens(),
    staleTime: 30_000,
  })
}

export function useRevokeApiToken() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => revokeApiToken(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['api-tokens'] }),
  })
}

/** 设置页「币种」组 */
export function useCurrencies() {
  return useQuery({
    queryKey: ['currencies'],
    queryFn: () => getCurrencies(),
    staleTime: 5 * 60_000,
  })
}

/** 设置页「关于」卡 */
export function useAbout() {
  return useQuery({
    queryKey: ['about'],
    queryFn: () => getAbout(),
    staleTime: 5 * 60_000,
  })
}

/**
 * autocomplete 系列：调用方负责防抖与 enabled（query 长度 ≥1，见 Combobox + RecordTransactionModal）。
 * 与 useSearchTransactions 同一模式。
 */
export function useAutocompleteAccounts(
  query: string,
  opts: { types?: string; enabled: boolean; limit?: number },
) {
  return useQuery({
    queryKey: ['autocomplete-accounts', query, opts.types ?? '', opts.limit ?? 10],
    queryFn: () => autocompleteAccounts(query, { types: opts.types, limit: opts.limit }),
    enabled: opts.enabled,
    staleTime: 30_000,
  })
}

export function useAutocompleteCategories(query: string, opts: { enabled: boolean; limit?: number }) {
  return useQuery({
    queryKey: ['autocomplete-categories', query, opts.limit ?? 10],
    queryFn: () => autocompleteCategories(query, { limit: opts.limit }),
    enabled: opts.enabled,
    staleTime: 30_000,
  })
}

export function useAutocompleteTags(query: string, opts: { enabled: boolean; limit?: number }) {
  return useQuery({
    queryKey: ['autocomplete-tags', query, opts.limit ?? 10],
    queryFn: () => autocompleteTags(query, { limit: opts.limit }),
    enabled: opts.enabled,
    staleTime: 30_000,
  })
}

export function useAutocompleteTransactions(query: string, opts: { enabled: boolean; limit?: number }) {
  return useQuery({
    queryKey: ['autocomplete-transactions', query, opts.limit ?? 10],
    queryFn: () => autocompleteTransactions(query, { limit: opts.limit }),
    enabled: opts.enabled,
    staleTime: 30_000,
  })
}

/**
 * 能力目录。整个应用的能力标签、风险档都从这里取——目录是唯一真源，
 * 网页端不再养手写副本（见 api/catalog.ts）。
 *
 * 目录只随部署变，缓存放长一点；取不到时调用方退回显示原始能力名，不挡功能。
 */
export function useCapabilityIndex() {
  const query = useQuery({
    queryKey: ['catalog'],
    queryFn: getCatalog,
    enabled: hasActiveToken(),
    staleTime: 30 * 60_000,
    retry: false,
  })

  const index = useMemo(
    () => (query.data ? indexCapabilities(query.data) : new Map<string, Capability>()),
    [query.data],
  )

  return {
    ...query,
    index,
    /** 找不到就把原始名字显示出来：宁可露出 `bills_import`，也别显示空白。 */
    labelFor: (name: string) => index.get(name)?.label ?? name,
    riskFor: (name: string) => index.get(name)?.risk,
  }
}
