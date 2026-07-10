import { z } from 'zod'

/** GET /api/v1/summary/basic 单项条目（宽松校验，其余字段 passthrough） */
export const summaryEntrySchema = z
  .object({
    key: z.string(),
    title: z.string().optional(),
    monetary_value: z.string(),
    value_parsed: z.string(),
    currency_symbol: z.string().optional(),
    currency_code: z.string().optional(),
    sub_title: z.string().optional(),
  })
  .passthrough()

export const summaryResponseSchema = z.record(z.string(), summaryEntrySchema)

export type SummaryEntry = z.infer<typeof summaryEntrySchema>
export type SummaryResponse = z.infer<typeof summaryResponseSchema>

/** GET /api/v1/transactions 单笔拆分 */
export const transactionSplitSchema = z
  .object({
    description: z.string(),
    amount: z.string(),
    currency_symbol: z.string(),
    type: z.enum(['withdrawal', 'deposit', 'transfer', 'reconciliation', 'opening balance']),
    date: z.string(),
    source_name: z.string().nullable(),
    destination_name: z.string().nullable(),
    category_name: z.string().nullable(),
  })
  .passthrough()

export const transactionGroupSchema = z
  .object({
    id: z.string(),
    attributes: z
      .object({
        transactions: z.array(transactionSplitSchema),
      })
      .passthrough(),
  })
  .passthrough()

export const transactionsResponseSchema = z
  .object({
    data: z.array(transactionGroupSchema),
    meta: z
      .object({
        pagination: z
          .object({
            total: z.number(),
            count: z.number(),
            per_page: z.number(),
            current_page: z.number(),
            total_pages: z.number(),
          })
          .partial()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

export type TransactionSplit = z.infer<typeof transactionSplitSchema>
export type TransactionsResponse = z.infer<typeof transactionsResponseSchema>

/**
 * GET /api/v1/accounts?type=asset|expense|revenue|liabilities
 * 记一笔表单的账户下拉与账户页共用；实测响应见 app/Transformers/AccountTransformer.php，
 * 这里只列出账户页需要的字段（尾号/余额/最近活动），其余 passthrough。
 */
export const accountAttributesSchema = z
  .object({
    name: z.string(),
    type: z.string(),
    active: z.boolean().optional(),
    currency_code: z.string().optional(),
    currency_symbol: z.string().optional(),
    current_balance: z.string().nullable().optional(),
    account_number: z.string().nullable().optional(),
    iban: z.string().nullable().optional(),
    last_activity: z.string().nullable().optional(),
    liability_type: z.string().nullable().optional(),
  })
  .passthrough()

export const accountSchema = z
  .object({
    id: z.string(),
    attributes: accountAttributesSchema,
  })
  .passthrough()

export const accountsResponseSchema = z
  .object({
    data: z.array(accountSchema),
    meta: z
      .object({
        pagination: z
          .object({
            total: z.number(),
            count: z.number(),
            per_page: z.number(),
            current_page: z.number(),
            total_pages: z.number(),
          })
          .partial()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

export type Account = z.infer<typeof accountSchema>
export type AccountsResponse = z.infer<typeof accountsResponseSchema>

/** POST /api/v1/transactions 响应：Item 资源，data 是单个对象而非数组 */
export const transactionCreateResponseSchema = z
  .object({
    data: transactionGroupSchema,
  })
  .passthrough()

export type TransactionCreateResponse = z.infer<typeof transactionCreateResponseSchema>

/**
 * GET /api/v1/insight/expense/category
 * 实测 GET /api/v1/insight/income/revenue、GET /api/v1/insight/expense/asset 返回结构完全一致
 * （数组，每项 {id,name,difference,difference_float,currency_code}），因此报表页三个排行区块复用同一 schema。
 */
export const insightCategoryEntrySchema = z
  .object({
    id: z.string().nullable().optional(),
    name: z.string(),
    difference_float: z.number(),
    currency_code: z.string().optional(),
  })
  .passthrough()

export const insightCategoryResponseSchema = z.array(insightCategoryEntrySchema)

export type InsightCategoryEntry = z.infer<typeof insightCategoryEntrySchema>

/** GET /api/v1/bill-inbox/summary（自建端点，见 docs/design/granary-web-plan.md §3） */
export const billInboxChannelSchema = z
  .object({
    key: z.string(),
    name: z.string(),
    last_received_at: z.string().nullable().optional(),
    needs_code: z.number(),
    unprocessed: z.number(),
    failed: z.number(),
    parsed: z.number(),
    to_store: z.number(),
    last_status: z.string().nullable().optional(),
  })
  .passthrough()

export const billInboxSummarySchema = z
  .object({
    pending_total: z.number(),
    needs_code: z.number(),
    unprocessed: z.number(),
    failed: z.number(),
    channels: z.array(billInboxChannelSchema),
  })
  .passthrough()

export type BillInboxSummary = z.infer<typeof billInboxSummarySchema>

/** GET /api/v1/daily-reconciliation/summary（自建端点） */
export const reconciliationDaySchema = z
  .object({
    date: z.string(),
    status: z.enum(['reconciled', 'diff', 'none', 'pending']),
    income: z.string(),
    expense: z.string(),
    net: z.string(),
    tx_count: z.number(),
    diff_amount: z.string().nullable().optional(),
  })
  .passthrough()

export const reconciliationSummarySchema = z
  .object({
    last_reconciled_date: z.string().nullable(),
    days_unreconciled: z.number(),
    days: z.array(reconciliationDaySchema),
  })
  .passthrough()

export type ReconciliationDay = z.infer<typeof reconciliationDaySchema>
export type ReconciliationSummary = z.infer<typeof reconciliationSummarySchema>

/** GET /api/v1/bill-tasks（自建端点）任务状态枚举 */
export const billTaskStatusSchema = z.enum([
  'received',
  'ready',
  'needs_secret',
  'parsed',
  'imported',
  'failed',
  'unknown',
  'ignored',
  'cleaned',
])

export type BillTaskStatus = z.infer<typeof billTaskStatusSchema>

export const billTaskRowCountsSchema = z
  .object({
    total: z.number(),
    pending: z.number(),
    imported: z.number(),
    duplicate: z.number(),
    conflict: z.number(),
  })
  .passthrough()

export const billTaskAttributesSchema = z
  .object({
    source: z.string(),
    profile_id: z.string().nullable().optional(),
    status: billTaskStatusSchema,
    received_at: z.string().nullable().optional(),
    summary: z.string().nullable().optional(),
    current_secret_challenge_id: z.union([z.string(), z.number()]).nullable().optional(),
    error_code: z.string().nullable().optional(),
    error_message: z.string().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    row_counts: billTaskRowCountsSchema,
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
  })
  .passthrough()

export const billTaskSchema = z
  .object({
    id: z.string(),
    attributes: billTaskAttributesSchema,
  })
  .passthrough()

export const billTasksResponseSchema = z
  .object({
    data: z.array(billTaskSchema),
    meta: z
      .object({
        pagination: z
          .object({
            total: z.number(),
            count: z.number(),
            per_page: z.number(),
            current_page: z.number(),
            total_pages: z.number(),
          })
          .partial()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

export type BillTask = z.infer<typeof billTaskSchema>
export type BillTasksResponse = z.infer<typeof billTasksResponseSchema>

/** GET /api/v1/bill-tasks/{id}/rows（自建端点）行状态/去重状态枚举 */
export const billRowStatusSchema = z.enum(['pending', 'imported', 'failed', 'needs_split', 'split'])
export const billRowDuplicateStateSchema = z.enum(['unique', 'duplicate', 'conflict'])

export type BillRowStatus = z.infer<typeof billRowStatusSchema>
export type BillRowDuplicateState = z.infer<typeof billRowDuplicateStateSchema>

export const billStatementRowAttributesSchema = z
  .object({
    bill_task_id: z.union([z.string(), z.number()]),
    status: billRowStatusSchema,
    occurred_at: z.string(),
    counterparty: z.string().nullable().optional(),
    direction: z.string().nullable().optional(),
    amount: z.string(),
    duplicate_state: billRowDuplicateStateSchema,
    duplicate_of_row_id: z.union([z.string(), z.number()]).nullable().optional(),
    firefly_type: z.enum(['withdrawal', 'deposit', 'transfer']).nullable().optional(),
    firefly_date: z.string().nullable().optional(),
    firefly_amount: z.string().nullable().optional(),
    firefly_description: z.string().nullable().optional(),
    source_name: z.string().nullable().optional(),
    destination_name: z.string().nullable().optional(),
    category_name: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    tags: z.array(z.string()).optional(),
    transaction_group_id: z.union([z.string(), z.number()]).nullable().optional(),
    error_message: z.string().nullable().optional(),
  })
  .passthrough()

export const billStatementRowSchema = z
  .object({
    id: z.string(),
    attributes: billStatementRowAttributesSchema,
  })
  .passthrough()

export const billStatementRowsResponseSchema = z
  .object({
    data: z.array(billStatementRowSchema),
  })
  .passthrough()

export type BillStatementRow = z.infer<typeof billStatementRowSchema>
export type BillStatementRowsResponse = z.infer<typeof billStatementRowsResponseSchema>

/** POST /api/v1/bill-tasks/{id}/import 响应 */
export const billImportRowResultSchema = z
  .object({
    row_id: z.string(),
    row_number: z.number().optional(),
    status: z.string(),
    occurred_at: z.string().optional(),
    direction: z.string().nullable().optional(),
    amount: z.string().optional(),
    firefly_type: z.string().nullable().optional(),
    firefly_amount: z.string().nullable().optional(),
    counterparty: z.string().nullable().optional(),
    description_preview: z.string().nullable().optional(),
    source_name: z.string().nullable().optional(),
    destination_name: z.string().nullable().optional(),
    category_name: z.string().nullable().optional(),
    duplicate_state: billRowDuplicateStateSchema.optional(),
    duplicate_of_row_id: z.union([z.string(), z.number()]).nullable().optional(),
    user_modified_at: z.string().nullable().optional(),
    error: z.string().nullable().optional(),
    transaction_group_id: z.union([z.string(), z.number()]).nullable().optional(),
  })
  .passthrough()

export const billImportResponseSchema = z
  .object({
    summary: z
      .object({
        total: z.number(),
        imported: z.number(),
        skipped: z.number(),
        failed: z.number(),
      })
      .passthrough(),
    rows: z.array(billImportRowResultSchema),
    balance_chain: z.array(z.unknown()).optional(),
  })
  .passthrough()

export type BillImportRowResult = z.infer<typeof billImportRowResultSchema>
export type BillImportResponse = z.infer<typeof billImportResponseSchema>

/**
 * GET /api/v1/budgets（预算与订阅页「预算」tab）。
 * 字段核对自 firefly-iii/app/Transformers/BudgetTransformer.php：spent 是按 start/end 查询参数
 * 计算出的当期花费数组（通常单币种一项），budget 对象本身不带"限额"——手动限额需另请求
 * GET /api/v1/budgets/{id}/limits。当前测试环境无预算数据，故按 transformer 源码而非实测响应建模。
 */
export const budgetSpentEntrySchema = z
  .object({
    sum: z.string(),
    currency_code: z.string().optional(),
    currency_symbol: z.string().optional(),
  })
  .passthrough()

export const budgetAttributesSchema = z
  .object({
    name: z.string(),
    active: z.boolean().optional(),
    order: z.number().nullable().optional(),
    currency_symbol: z.string().optional(),
    auto_budget_amount: z.string().nullable().optional(),
    spent: z.array(budgetSpentEntrySchema).nullable().optional(),
  })
  .passthrough()

export const budgetSchema = z
  .object({
    id: z.string(),
    attributes: budgetAttributesSchema,
  })
  .passthrough()

export const budgetsResponseSchema = z
  .object({
    data: z.array(budgetSchema),
  })
  .passthrough()

export type Budget = z.infer<typeof budgetSchema>
export type BudgetsResponse = z.infer<typeof budgetsResponseSchema>

/** GET /api/v1/budgets/{id}/limits（核对自 app/Transformers/BudgetLimitTransformer.php） */
export const budgetLimitAttributesSchema = z
  .object({
    budget_id: z.string(),
    start: z.string(),
    end: z.string(),
    amount: z.string(),
    currency_symbol: z.string().optional(),
    spent: z.union([z.string(), z.number()]).nullable().optional(),
  })
  .passthrough()

export const budgetLimitSchema = z
  .object({
    id: z.string(),
    attributes: budgetLimitAttributesSchema,
  })
  .passthrough()

export const budgetLimitsResponseSchema = z
  .object({
    data: z.array(budgetLimitSchema),
  })
  .passthrough()

export type BudgetLimit = z.infer<typeof budgetLimitSchema>
export type BudgetLimitsResponse = z.infer<typeof budgetLimitsResponseSchema>

/**
 * GET /api/v1/bills（预算与订阅页「订阅」tab）。
 * 字段核对自 firefly-iii/app/Transformers/BillTransformer.php。当前测试环境无订阅数据。
 */
export const billAttributesSchema = z
  .object({
    name: z.string(),
    active: z.boolean().optional(),
    currency_symbol: z.string().optional(),
    amount_min: z.string().nullable().optional(),
    amount_max: z.string().nullable().optional(),
    repeat_freq: z.string().optional(),
    next_expected_match: z.string().nullable().optional(),
  })
  .passthrough()

export const billSchema = z
  .object({
    id: z.string(),
    attributes: billAttributesSchema,
  })
  .passthrough()

export const billsResponseSchema = z
  .object({
    data: z.array(billSchema),
  })
  .passthrough()

export type Bill = z.infer<typeof billSchema>
export type BillsResponse = z.infer<typeof billsResponseSchema>

/**
 * GET /api/v1/piggy-banks（预算与订阅页「储蓄罐」tab）。
 * 字段核对自 firefly-iii/app/Transformers/PiggyBankTransformer.php。当前测试环境无储蓄罐数据。
 */
export const piggyBankAttributesSchema = z
  .object({
    name: z.string(),
    active: z.boolean().optional(),
    currency_symbol: z.string().optional(),
    percentage: z.number().nullable().optional(),
    target_amount: z.string().nullable().optional(),
    current_amount: z.string().nullable().optional(),
    left_to_save: z.string().nullable().optional(),
  })
  .passthrough()

export const piggyBankSchema = z
  .object({
    id: z.string(),
    attributes: piggyBankAttributesSchema,
  })
  .passthrough()

export const piggyBanksResponseSchema = z
  .object({
    data: z.array(piggyBankSchema),
  })
  .passthrough()

export type PiggyBank = z.infer<typeof piggyBankSchema>
export type PiggyBanksResponse = z.infer<typeof piggyBanksResponseSchema>

/** GET /api/v1/categories（设置页「分类与标签」组，实测 limit=200 时 data 直接返回全量+meta.pagination.total） */
export const categoryAttributesSchema = z.object({ name: z.string() }).passthrough()
export const categorySchema = z.object({ id: z.string(), attributes: categoryAttributesSchema }).passthrough()
export const categoriesResponseSchema = z
  .object({
    data: z.array(categorySchema),
    meta: z
      .object({ pagination: z.object({ total: z.number() }).partial().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough()

export type Category = z.infer<typeof categorySchema>
export type CategoriesResponse = z.infer<typeof categoriesResponseSchema>

/** GET /api/v1/tags（设置页「分类与标签」组）：标签名字段是 attributes.tag，非 name（实测确认） */
export const tagAttributesSchema = z.object({ tag: z.string() }).passthrough()
export const tagSchema = z.object({ id: z.string(), attributes: tagAttributesSchema }).passthrough()
export const tagsResponseSchema = z
  .object({
    data: z.array(tagSchema),
    meta: z
      .object({ pagination: z.object({ total: z.number() }).partial().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough()

export type Tag = z.infer<typeof tagSchema>
export type TagsResponse = z.infer<typeof tagsResponseSchema>

/**
 * GET /api/v1/rules、GET /api/v1/recurrences（设置页「自动化」组）。
 * 测试环境两者均无数据，字段核对自 app/Transformers/RuleTransformer.php 与
 * RecurrenceTransformer.php 源码（均有 title/active 字段），未做实测响应校验。
 */
export const ruleAttributesSchema = z.object({ title: z.string(), active: z.boolean().optional() }).passthrough()
export const ruleSchema = z.object({ id: z.string(), attributes: ruleAttributesSchema }).passthrough()
export const rulesResponseSchema = z
  .object({
    data: z.array(ruleSchema),
    meta: z
      .object({ pagination: z.object({ total: z.number() }).partial().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough()

export type Rule = z.infer<typeof ruleSchema>
export type RulesResponse = z.infer<typeof rulesResponseSchema>

export const recurrenceAttributesSchema = z.object({ title: z.string(), active: z.boolean().optional() }).passthrough()
export const recurrenceSchema = z.object({ id: z.string(), attributes: recurrenceAttributesSchema }).passthrough()
export const recurrencesResponseSchema = z
  .object({
    data: z.array(recurrenceSchema),
    meta: z
      .object({ pagination: z.object({ total: z.number() }).partial().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough()

export type Recurrence = z.infer<typeof recurrenceSchema>
export type RecurrencesResponse = z.infer<typeof recurrencesResponseSchema>

/** GET /api/v1/currencies（设置页「币种」组，实测字段 name/code/symbol/enabled/default） */
export const currencyAttributesSchema = z
  .object({
    name: z.string(),
    code: z.string(),
    symbol: z.string(),
    enabled: z.boolean().optional(),
    default: z.boolean().optional(),
  })
  .passthrough()
export const currencySchema = z.object({ id: z.string(), attributes: currencyAttributesSchema }).passthrough()
export const currenciesResponseSchema = z.object({ data: z.array(currencySchema) }).passthrough()

export type Currency = z.infer<typeof currencySchema>
export type CurrenciesResponse = z.infer<typeof currenciesResponseSchema>

/** GET /api/v1/about（设置页「关于」卡，实测字段 version/api_version/php_version/os/driver） */
export const aboutDataSchema = z
  .object({
    version: z.string(),
    api_version: z.string().optional(),
    php_version: z.string().optional(),
    os: z.string().optional(),
    driver: z.string().optional(),
  })
  .passthrough()
export const aboutResponseSchema = z.object({ data: aboutDataSchema }).passthrough()

export type AboutData = z.infer<typeof aboutDataSchema>
export type AboutResponse = z.infer<typeof aboutResponseSchema>

/**
 * autocomplete 系列（GET /api/v1/autocomplete/*）实测均为**纯 JSON 数组**，
 * 不是 JSON:API `{data:[...]}` 包裹——与列表端点形状不同，勿混用。
 */

/** GET /api/v1/autocomplete/accounts?query=&limit=&types= 实测字段 */
export const autocompleteAccountSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    name_with_balance: z.string().optional(),
    type: z.string().optional(),
    active: z.boolean().optional(),
  })
  .passthrough()

export const autocompleteAccountsSchema = z.array(autocompleteAccountSchema)
export type AutocompleteAccount = z.infer<typeof autocompleteAccountSchema>

/** GET /api/v1/autocomplete/categories?query=&limit= 实测 [{id, name}] */
export const autocompleteCategorySchema = z
  .object({
    id: z.string(),
    name: z.string(),
  })
  .passthrough()

export const autocompleteCategoriesSchema = z.array(autocompleteCategorySchema)
export type AutocompleteCategory = z.infer<typeof autocompleteCategorySchema>

/** GET /api/v1/autocomplete/tags?query=&limit= 实测 [{id, name, tag}]（name 与 tag 同值） */
export const autocompleteTagSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    tag: z.string().optional(),
  })
  .passthrough()

export const autocompleteTagsSchema = z.array(autocompleteTagSchema)
export type AutocompleteTag = z.infer<typeof autocompleteTagSchema>

/**
 * GET /api/v1/autocomplete/transactions?query=&limit=
 * 实测 [{id, transaction_group_id, name, description}]——描述历史补全用 name/description。
 */
export const autocompleteTransactionSchema = z
  .object({
    id: z.string(),
    transaction_group_id: z.string().optional(),
    name: z.string(),
    description: z.string().optional(),
  })
  .passthrough()

export const autocompleteTransactionsSchema = z.array(autocompleteTransactionSchema)
export type AutocompleteTransaction = z.infer<typeof autocompleteTransactionSchema>
