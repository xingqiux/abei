import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createTransaction,
  getAbout,
  getAccountsByType,
  getAssetAccounts,
  getBillInboxSummary,
  getBillTaskRows,
  getBillTasks,
  getBills,
  getBudgetLimits,
  getBudgets,
  getCategories,
  getCurrencies,
  getExpenseByAsset,
  getExpenseByCategory,
  getIncomeByRevenue,
  getPiggyBanks,
  getReconciliationSummary,
  getRecurrences,
  getRules,
  getSummaryBasic,
  getTags,
  getTransactions,
  ignoreBillTask,
  importBillTaskRows,
  searchTransactions,
  type AccountType,
  type CreateTransactionInput,
  type DateRange,
  type TransactionTypeFilter,
} from './firefly'

export function useSummaryBasic(range: DateRange) {
  return useQuery({
    queryKey: ['summary-basic', range.start, range.end],
    queryFn: () => getSummaryBasic(range),
  })
}

export function useTransactions(
  range: DateRange,
  opts: { limit?: number; page?: number; type?: TransactionTypeFilter; enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ['transactions', range.start, range.end, opts.limit, opts.page, opts.type],
    queryFn: () => getTransactions(range, opts),
    enabled: opts.enabled ?? true,
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

export function useExpenseByCategory(range: DateRange) {
  return useQuery({
    queryKey: ['expense-by-category', range.start, range.end],
    queryFn: () => getExpenseByCategory(range),
  })
}

/** 报表页「收入来源排行」 */
export function useIncomeByRevenue(range: DateRange) {
  return useQuery({
    queryKey: ['income-by-revenue', range.start, range.end],
    queryFn: () => getIncomeByRevenue(range),
  })
}

/** 报表页「账户流出排行」 */
export function useExpenseByAsset(range: DateRange) {
  return useQuery({
    queryKey: ['expense-by-asset', range.start, range.end],
    queryFn: () => getExpenseByAsset(range),
  })
}

export function useBillInboxSummary() {
  return useQuery({
    queryKey: ['bill-inbox-summary'],
    queryFn: () => getBillInboxSummary(),
    staleTime: 60_000,
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
 * 「需处理」这类合并了多个 status 的 tab 用 useQueries 并发拉取每个 status 再在
 * 调用方合并排序。用增大 limit（而非翻页）实现"加载更多"：接口本身分页良好，
 * 但合并多个 status 的结果后按页合并较复杂，直接整体多取更简单可靠。
 */
export function useBillTasksByStatuses(
  statuses: string[],
  opts: { source?: string; limit: number },
) {
  return useQueries({
    queries: statuses.map((status) => ({
      queryKey: ['bill-tasks', opts.source ?? 'all', status, opts.limit],
      queryFn: () => getBillTasks({ source: opts.source, status, limit: opts.limit, page: 1 }),
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
    },
  })
}

export function useIgnoreBillTask() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (taskId: string) => ignoreBillTask(taskId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bill-inbox-summary'] })
      queryClient.invalidateQueries({ queryKey: ['bill-tasks'] })
    },
  })
}

/** 记一笔表单的资产账户下拉；变动很少，缓存 5 分钟 */
export function useAssetAccounts() {
  return useQuery({
    queryKey: ['accounts', 'asset'],
    queryFn: () => getAssetAccounts(),
    staleTime: 5 * 60_000,
  })
}

/** 记一笔表单提交：成功后让交易列表/KPI/分类洞察缓存失效 */
export function useCreateTransaction() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateTransactionInput) => createTransaction(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transactions'] })
      queryClient.invalidateQueries({ queryKey: ['summary-basic'] })
      queryClient.invalidateQueries({ queryKey: ['expense-by-category'] })
    },
  })
}

/** 账户页四个 tab；用增大 limit（而非翻页）实现「加载更多」，与账单收件箱任务列表同一惯例 */
export function useAccountsByType(type: AccountType, opts: { limit: number }) {
  return useQuery({
    queryKey: ['accounts', type, opts.limit],
    queryFn: () => getAccountsByType(type, { limit: opts.limit, page: 1 }),
    staleTime: 30_000,
  })
}

/** 预算与订阅页「预算」tab：用全局日期范围 store 计算当期已花费 */
export function useBudgets(range: DateRange) {
  return useQuery({
    queryKey: ['budgets', range.start, range.end],
    queryFn: () => getBudgets(range),
  })
}

/**
 * 每个预算各自的手动限额（0~1 条，通常按月设置）。budgetIds 为空时 useQueries 直接返回空数组，
 * 调用方按下标与 budgetIds 一一对应读取结果（同 useBudgetTasksByStatuses 的用法）。
 */
export function useBudgetLimits(budgetIds: string[], range: DateRange) {
  return useQueries({
    queries: budgetIds.map((id) => ({
      queryKey: ['budget-limits', id, range.start, range.end],
      queryFn: () => getBudgetLimits(id, range),
      staleTime: 60_000,
    })),
  })
}

/** 预算与订阅页「订阅」tab */
export function useBills() {
  return useQuery({
    queryKey: ['bills'],
    queryFn: () => getBills(),
    staleTime: 60_000,
  })
}

/** 预算与订阅页「储蓄罐」tab */
export function usePiggyBanks() {
  return useQuery({
    queryKey: ['piggy-banks'],
    queryFn: () => getPiggyBanks(),
    staleTime: 60_000,
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

/** 设置页「自动化」组 */
export function useRules() {
  return useQuery({
    queryKey: ['rules'],
    queryFn: () => getRules(),
    staleTime: 60_000,
  })
}

export function useRecurrences() {
  return useQuery({
    queryKey: ['recurrences'],
    queryFn: () => getRecurrences(),
    staleTime: 60_000,
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
