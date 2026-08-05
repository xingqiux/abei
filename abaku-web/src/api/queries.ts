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
  createAccount,
  createTransactionAttachment,
  createTransaction,
  createTransactionSplits,
  cleanupBillInbox,
  countTransactions,
  deleteTransaction,
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
  createBudget,
  createBudgetLimit,
  createBudgetWithLimit,
  createReconciliationAdjustment,
  getBudgetLimits,
  getBudgets,
  getCategories,
  markDayTransactionsReconciled,
  getCurrencies,
  getExpenseByAsset,
  getExpenseByBudget,
  getExpenseByCategory,
  getExpenseByTag,
  getExpenseWithoutBudget,
  getExpenseWithoutCategory,
  getIncomeByRevenue,
  getFinancialReport,
  getReconciliationSummary,
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
} from './firefly'
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

export function useReconciliationSummary(days = 30) {
  return useQuery({
    queryKey: ['reconciliation-summary', days],
    queryFn: () => getReconciliationSummary(days),
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

/** PATCH bill-statement-rows/{id}：成功后刷新该任务行列表 */
export function useUpdateBillStatementRow() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ rowId, input }: { rowId: string; input: UpdateBillStatementRowInput }) =>
      updateBillStatementRow(rowId, input),
    onSuccess: (res) => {
      const taskId = String(res.data.attributes.bill_task_id)
      queryClient.invalidateQueries({ queryKey: ['bill-task-rows', taskId] })
      queryClient.invalidateQueries({ queryKey: ['bill-task-review', taskId] })
      queryClient.invalidateQueries({ queryKey: ['bill-tasks'] })
      queryClient.invalidateQueries({ queryKey: ['bill-inbox-summary'] })
    },
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
      queryClient.invalidateQueries({ queryKey: ['bill-inbox-summary'] })
    },
  })
}

/** 干跑（confirm:false）与正式提交（confirm:true）复用同一 mutation，由调用方决定何时刷新缓存 */
export function useImportBillTaskRows() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ taskId, rowIds, all, confirm }: { taskId: string; rowIds?: string[]; all?: boolean; confirm: boolean }) =>
      importBillTaskRows(taskId, { row_ids: rowIds, all, confirm }),
    onSuccess: (_data, variables) => {
      if (!variables.confirm) return
      // 只在正式入账（非干跑）后才需要让相关缓存失效
      queryClient.invalidateQueries({ queryKey: ['bill-inbox-summary'] })
      queryClient.invalidateQueries({ queryKey: ['bill-tasks'] })
      queryClient.invalidateQueries({ queryKey: ['bill-task-rows', variables.taskId] })
      queryClient.invalidateQueries({ queryKey: ['bill-task-review', variables.taskId] })
      queryClient.invalidateQueries({ queryKey: ['bill-task-events', variables.taskId] })
      invalidateTransactionCaches(queryClient)
    },
  })
}

export function useIgnoreBillTask() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (taskId: string) => ignoreBillTask(taskId),
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

export function useSubmitBillTaskSecret() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ taskId, value }: { taskId: string; value: string }) =>
      submitBillTaskSecret(taskId, value),
    onSuccess: (_data, variables) => {
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
  queryClient.invalidateQueries({ queryKey: ['reconciliation-summary'] })
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

/** 标记某日全部交易已对账（方案 b） */
export function useMarkDayReconciled() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (date: string) => markDayTransactionsReconciled(date),
    onSuccess: () => {
      invalidateTransactionCaches(queryClient)
    },
  })
}

/** 生成对账调整交易（type=reconciliation） */
export function useCreateReconciliationAdjustment() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      date: string
      amount: string
      account_id: string
      direction: 'decrease' | 'increase'
      description?: string
    }) => createReconciliationAdjustment(input),
    onSuccess: () => invalidateTransactionCaches(queryClient),
  })
}

/** 设置页「分类与标签」组：变动很少，缓存 5 分钟 */
export function useCategories() {
  return useQuery({
    queryKey: ['categories'],
    queryFn: () => getCategories(),
    staleTime: 5 * 60_000,
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
