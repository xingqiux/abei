import { z } from 'zod'

export const paginationSchema = z
  .object({
    total: z.number(),
    count: z.number(),
    per_page: z.number(),
    current_page: z.number(),
    total_pages: z.number(),
  })
  .partial()
  .passthrough()

export const paginationMetaSchema = z
  .object({ pagination: paginationSchema.optional() })
  .passthrough()

function paginatedCollectionSchema<T extends z.ZodType>(itemSchema: T) {
  return z
    .object({
      data: z.array(itemSchema),
      meta: paginationMetaSchema.optional(),
    })
    .passthrough()
}

/** GET /api/v1/summary/basic 单项条目（宽松校验，其余字段 passthrough） */
export const summaryEntrySchema = z
  .object({
    key: z.string(),
    title: z.string().optional(),
    monetary_value: z.string(),
    value_parsed: z.string(),
    currency_symbol: z.string().optional(),
    currency_code: z.string().optional(),
    currency_decimal_places: z.number().optional(),
    sub_title: z.string().optional(),
  })
  .passthrough()

export const summaryResponseSchema = z.record(z.string(), summaryEntrySchema)

export type SummaryEntry = z.infer<typeof summaryEntrySchema>
export type SummaryResponse = z.infer<typeof summaryResponseSchema>

/** GET /api/v1/transactions 单笔拆分（列表与详情共用；编辑需 journal_id / 账户 id） */
export const transactionSplitSchema = z
  .object({
    description: z.string(),
    amount: z.string(),
    currency_code: z.string().nullable().optional(),
    currency_symbol: z.string(),
    type: z.enum(['withdrawal', 'deposit', 'transfer', 'reconciliation', 'opening balance']),
    date: z.string(),
    source_name: z.string().nullable(),
    destination_name: z.string().nullable(),
    category_name: z.string().nullable(),
    currency_id: z.union([z.string(), z.number()]).nullable().optional(),
    foreign_currency_id: z.union([z.string(), z.number()]).nullable().optional(),
    foreign_currency_code: z.string().nullable().optional(),
    foreign_amount: z.string().nullable().optional(),
    budget_id: z.union([z.string(), z.number()]).nullable().optional(),
    budget_name: z.string().nullable().optional(),
    category_id: z.union([z.string(), z.number()]).nullable().optional(),
    bill_id: z.union([z.string(), z.number()]).nullable().optional(),
    bill_name: z.string().nullable().optional(),
    /** 拆分 journal id；PUT 时必带（实测 string） */
    transaction_journal_id: z.union([z.string(), z.number()]).optional(),
    source_id: z.union([z.string(), z.number()]).nullable().optional(),
    destination_id: z.union([z.string(), z.number()]).nullable().optional(),
    tags: z.array(z.string()).nullable().optional(),
    notes: z.string().nullable().optional(),
    reconciled: z.boolean().optional(),
  })
  .passthrough()

export const transactionGroupSchema = z
  .object({
    id: z.string(),
    attributes: z
      .object({
        group_title: z.string().nullable().optional(),
        transactions: z.array(transactionSplitSchema),
      })
      .passthrough(),
  })
  .passthrough()

export const transactionsResponseSchema = paginatedCollectionSchema(transactionGroupSchema)

export type TransactionSplit = z.infer<typeof transactionSplitSchema>
export type TransactionsResponse = z.infer<typeof transactionsResponseSchema>

export const transactionSearchCountSchema = z.object({ count: z.number() })
export type TransactionSearchCount = z.infer<typeof transactionSearchCountSchema>

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
    liability_direction: z.enum(['credit', 'debit']).nullable().optional(),
    interest: z.string().nullable().optional(),
    interest_period: z.enum(['daily', 'weekly', 'monthly', 'quarterly', 'half-year', 'yearly']).nullable().optional(),
    opening_balance: z.string().nullable().optional(),
    opening_balance_date: z.string().nullable().optional(),
    account_role: z.string().nullable().optional(),
    credit_card_type: z.string().nullable().optional(),
    monthly_payment_date: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    include_net_worth: z.boolean().optional(),
  })
  .passthrough()

export const accountSchema = z
  .object({
    id: z.string(),
    attributes: accountAttributesSchema,
  })
  .passthrough()

export const accountsResponseSchema = paginatedCollectionSchema(accountSchema)

export type Account = z.infer<typeof accountSchema>
export type AccountsResponse = z.infer<typeof accountsResponseSchema>

/** GET /api/v1/accounts/{id} —— Item 资源（data 为单对象） */
export const accountDetailResponseSchema = z
  .object({
    data: accountSchema,
  })
  .passthrough()

export type AccountDetailResponse = z.infer<typeof accountDetailResponseSchema>

export const accountItemResponseSchema = accountDetailResponseSchema

/**
 * POST/PUT /api/v1/transactions 与 GET /api/v1/transactions/{id} 响应：
 * Item 资源，data 是单个对象而非数组（与列表 Collection 不同）。
 */
export const transactionCreateResponseSchema = z
  .object({
    data: transactionGroupSchema,
  })
  .passthrough()

export type TransactionCreateResponse = z.infer<typeof transactionCreateResponseSchema>
/** GET/PUT 单笔与创建响应同形 */
export const transactionDetailResponseSchema = transactionCreateResponseSchema
export type TransactionDetailResponse = TransactionCreateResponse

/**
 * GET /api/v1/insight/expense/category
 * 实测 GET /api/v1/insight/income/revenue、GET /api/v1/insight/expense/asset 返回结构完全一致
 * （数组，每项 {id,name,difference,difference_float,currency_code}），因此报表页三个排行区块复用同一 schema。
 */
export const insightCategoryEntrySchema = z
  .object({
    id: z.string().nullable().optional(),
    name: z.string().optional().default('未分类'),
    difference: z.string(),
    difference_float: z.number().optional(),
    currency_code: z.string(),
  })
  .passthrough()

export const insightCategoryResponseSchema = z.array(insightCategoryEntrySchema)

export type InsightCategoryEntry = z.infer<typeof insightCategoryEntrySchema>

export const financialReportResponseSchema = z.object({
  data: z.object({
    top_expenses: z.array(z.object({
      group_id: z.string(),
      title: z.string(),
      date: z.string(),
      amount: z.string(),
      currency_id: z.string(),
      currency_code: z.string(),
      currency_symbol: z.string(),
      split_count: z.number(),
    })),
    transfer_flows: z.array(z.object({
      source_account_id: z.string(),
      source_account_name: z.string(),
      destination_account_id: z.string(),
      destination_account_name: z.string(),
      amount: z.string(),
      currency_id: z.string(),
      currency_code: z.string(),
      currency_symbol: z.string(),
      transaction_count: z.number(),
    })),
  }),
})

export type FinancialReportResponse = z.infer<typeof financialReportResponseSchema>

/** GET /api/v1/bill-inbox/summary（本项目账单收件箱汇总端点）。 */
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

export const billInboxSettingsSchema = z.object({
  data: z.object({
    type: z.string(),
    attributes: z.object({
      enabled: z.boolean(),
      provider: z.enum(['gmail', 'imap']),
      email: z.string(),
      host: z.string(),
      port: z.number(),
      encryption: z.enum(['none', 'ssl', 'tls', 'starttls']),
      username: z.string(),
      folder: z.string(),
      has_password: z.boolean(),
      built_in_channels: z.array(z.unknown()).optional(),
    }),
  }),
})

export const billInboxProcessResultSchema = z.object({
  data: z.object({
    attributes: z.object({ processed: z.number(), failed: z.number() }),
  }),
})

export const billInboxCleanupResultSchema = z.object({
  data: z.object({ attributes: z.object({ archived: z.number() }) }),
})

export type BillInboxSettings = z.infer<typeof billInboxSettingsSchema>
export type BillInboxProcessResult = z.infer<typeof billInboxProcessResultSchema>
export type BillInboxCleanupResult = z.infer<typeof billInboxCleanupResultSchema>

/** GET /api/v1/daily-reconciliation/summary（自建端点） */
export const reconciliationCurrencyTotalSchema = z.object({
  currency_id: z.number().nullable().optional(),
  currency_code: z.string(),
  currency_symbol: z.string(),
  income: z.string(),
  expense: z.string(),
  net: z.string(),
})

export const reconciliationDifferenceTotalSchema = z.object({
  currency_id: z.number().nullable().optional(),
  currency_code: z.string(),
  currency_symbol: z.string(),
  amount: z.string(),
})

export const reconciliationDaySchema = z
  .object({
    date: z.string(),
    status: z.enum(['reconciled', 'diff', 'none', 'pending']),
    income: z.string().nullable(),
    expense: z.string().nullable(),
    net: z.string().nullable(),
    tx_count: z.number(),
    diff_amount: z.string().nullable().optional(),
    currency_totals: z.array(reconciliationCurrencyTotalSchema).default([]),
    diff_totals: z.array(reconciliationDifferenceTotalSchema).default([]),
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

export const reconciliationActionResultSchema = z.object({
  date: z.string(),
  total: z.number(),
  updated: z.number(),
  already_reconciled: z.number(),
  transactions_updated: z.number(),
})

export type ReconciliationActionResult = z.infer<typeof reconciliationActionResultSchema>

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
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
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

export const billTasksResponseSchema = paginatedCollectionSchema(billTaskSchema)

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
    occurred_at: z.string().nullable(),
    counterparty: z.string().nullable().optional(),
    direction: z.string().nullable().optional(),
    amount: z.string().nullable(),
    currency_code: z.string().nullable().optional(),
    currency_symbol: z.string().nullable().optional(),
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
    tags: z.array(z.string()).nullable().optional(),
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

/** PATCH /api/v1/bill-statement-rows/{id} 响应：单条 Item */
export const billStatementRowItemResponseSchema = z
  .object({
    data: billStatementRowSchema,
  })
  .passthrough()

export type BillStatementRowItemResponse = z.infer<typeof billStatementRowItemResponseSchema>

/** POST /api/v1/bill-tasks/{id}/import 响应 */
export const billImportRowResultSchema = z
  .object({
    row_id: z.string(),
    row_number: z.number().optional(),
    status: z.string(),
    action: z.enum(['would_import', 'skip', 'imported', 'failed']).optional(),
    occurred_at: z.string().optional(),
    direction: z.string().nullable().optional(),
    amount: z.string().optional(),
    firefly_type: z.string().nullable().optional(),
    firefly_amount: z.string().nullable().optional(),
    currency_code: z.string().nullable().optional(),
    currency_symbol: z.string().nullable().optional(),
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
 * POST /api/v1/bill-inbox/sync 响应（对照 BillInboxController@sync）。
 * 可选 limit；会真实扫邮箱，前端验证时只点一次。
 */
export const billInboxSyncResultSchema = z
  .object({
    data: z
      .object({
        type: z.string().optional(),
        attributes: z
          .object({
            scanned: z.number(),
            created: z.number(),
            ignored: z.number(),
            duplicates: z.number(),
            failed: z.number(),
            processed: z.number(),
            process_failed: z.number(),
            errors: z.array(z.unknown()).optional(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough()

export type BillInboxSyncResult = z.infer<typeof billInboxSyncResultSchema>

/** POST secret / retry 返回单个 bill-task Item（与列表 data[] 项同形） */
export const billTaskItemResponseSchema = z
  .object({
    data: billTaskSchema,
  })
  .passthrough()

export type BillTaskItemResponse = z.infer<typeof billTaskItemResponseSchema>

export const billRowSplitResponseSchema = z.object({
  parent: billStatementRowSchema,
  data: z.array(billStatementRowSchema),
})

export type BillRowSplitResponse = z.infer<typeof billRowSplitResponseSchema>

export const billArtifactSchema = z.object({
  id: z.string(),
  attributes: z.object({
    bill_task_id: z.string(),
    kind: z.string(),
    filename: z.string().nullable().optional(),
    encrypted: z.boolean().optional(),
    mime_type: z.string(),
    size: z.number().nullable(),
    generation_stage: z.enum(['received', 'downloaded', 'extracted', 'derived']),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
    download_url: z.string(),
    created_at: z.string().nullable().optional(),
  }).passthrough(),
}).passthrough()

export const billArtifactsResponseSchema = z.object({ data: z.array(billArtifactSchema) })
export type BillArtifact = z.infer<typeof billArtifactSchema>
export type BillArtifactsResponse = z.infer<typeof billArtifactsResponseSchema>

export const billTaskEventSchema = z.object({
  id: z.string(),
  attributes: z.object({
    bill_task_id: z.string(),
    event_type: z.string(),
    message: z.string().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
    created_at: z.string().nullable().optional(),
  }).passthrough(),
}).passthrough()

export const billTaskEventsResponseSchema = z.object({ data: z.array(billTaskEventSchema) })
export type BillTaskEvent = z.infer<typeof billTaskEventSchema>
export type BillTaskEventsResponse = z.infer<typeof billTaskEventsResponseSchema>

const billReviewCandidateSchema = z.object({
  row_id: z.string(),
  reason: z.string().optional(),
  row_number: z.number().optional(),
  status: z.string().optional(),
  occurred_at: z.string().nullable().optional(),
  direction: z.string().nullable().optional(),
  amount: z.string().nullable().optional(),
  firefly_amount: z.string().nullable().optional(),
  currency_code: z.string().nullable().optional(),
  currency_symbol: z.string().nullable().optional(),
  counterparty: z.string().nullable().optional(),
  description_preview: z.string().nullable().optional(),
  source_name: z.string().nullable().optional(),
  destination_name: z.string().nullable().optional(),
  category_name: z.string().nullable().optional(),
}).passthrough()

export const billTaskReviewSchema = z.object({
  summary: z.record(z.string(), z.unknown()),
  new_candidates: z.array(billReviewCandidateSchema),
  existing_candidates: z.array(billReviewCandidateSchema),
  cross_source_candidates: z.array(billReviewCandidateSchema),
  duplicate_candidates: z.array(billReviewCandidateSchema),
  conflict_candidates: z.array(billReviewCandidateSchema),
  preserved_user_edits: z.array(billReviewCandidateSchema),
  skip_candidates: z.array(billReviewCandidateSchema),
  transfer_candidates: z.array(billReviewCandidateSchema),
  refund_pairs: z.array(z.unknown()),
  needs_user_note: z.array(billReviewCandidateSchema),
  balance_chain: z.unknown(),
}).passthrough()

export type BillTaskReview = z.infer<typeof billTaskReviewSchema>

export const attachmentAttributesSchema = z.object({
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  attachable_id: z.string(),
  attachable_type: z.string(),
  filename: z.string(),
  download_url: z.string(),
  upload_url: z.string(),
  title: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  mime: z.string().nullable().optional(),
  size: z.number(),
}).passthrough()

export const attachmentSchema = z.object({
  id: z.string(),
  attributes: attachmentAttributesSchema,
}).passthrough()

export const attachmentItemResponseSchema = z.object({ data: attachmentSchema }).passthrough()
export const attachmentsResponseSchema = paginatedCollectionSchema(attachmentSchema)
export type Attachment = z.infer<typeof attachmentSchema>
export type AttachmentItemResponse = z.infer<typeof attachmentItemResponseSchema>
export type AttachmentsResponse = z.infer<typeof attachmentsResponseSchema>

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

/**
 * BudgetTransformer：无自有币种时 currency_* 全为 null（object_has_currency_setting=false）。
 * 必须 .nullable()，否则 z.string().optional() 会拒收 null，POST/列表 parse 全挂。
 */
export const budgetAttributesSchema = z
  .object({
    name: z.string(),
    active: z.boolean().optional(),
    order: z.number().nullable().optional(),
    notes: z.string().nullable().optional(),
    auto_budget_type: z.string().nullable().optional(),
    auto_budget_period: z.string().nullable().optional(),
    auto_budget_amount: z.string().nullable().optional(),
    object_has_currency_setting: z.boolean().optional(),
    currency_id: z.string().nullable().optional(),
    currency_code: z.string().nullable().optional(),
    currency_name: z.string().nullable().optional(),
    currency_symbol: z.string().nullable().optional(),
    currency_decimal_places: z.number().nullable().optional(),
    primary_currency_id: z.string().nullable().optional(),
    primary_currency_code: z.string().nullable().optional(),
    primary_currency_name: z.string().nullable().optional(),
    primary_currency_symbol: z.string().nullable().optional(),
    primary_currency_decimal_places: z.number().nullable().optional(),
    spent: z.array(budgetSpentEntrySchema).nullable().optional(),
  })
  .passthrough()

export const budgetSchema = z
  .object({
    id: z.string(),
    attributes: budgetAttributesSchema,
  })
  .passthrough()

export const budgetsResponseSchema = paginatedCollectionSchema(budgetSchema)

export type Budget = z.infer<typeof budgetSchema>
export type BudgetsResponse = z.infer<typeof budgetsResponseSchema>

/** GET /api/v1/budgets/{id}/limits（核对自 app/Transformers/BudgetLimitTransformer.php） */
export const budgetLimitAttributesSchema = z
  .object({
    budget_id: z.string(),
    start: z.string(),
    end: z.string(),
    amount: z.string(),
    object_has_currency_setting: z.boolean().optional(),
    currency_id: z.string().nullable().optional(),
    currency_code: z.string().nullable().optional(),
    currency_name: z.string().nullable().optional(),
    currency_symbol: z.string().nullable().optional(),
    currency_decimal_places: z.number().nullable().optional(),
    primary_currency_id: z.string().nullable().optional(),
    primary_currency_code: z.string().nullable().optional(),
    primary_currency_name: z.string().nullable().optional(),
    primary_currency_symbol: z.string().nullable().optional(),
    primary_currency_decimal_places: z.number().nullable().optional(),
    spent: z.array(budgetSpentEntrySchema).nullable().optional(),
  })
  .passthrough()

export const budgetLimitSchema = z
  .object({
    id: z.string(),
    attributes: budgetLimitAttributesSchema,
  })
  .passthrough()

export const budgetLimitsResponseSchema = paginatedCollectionSchema(budgetLimitSchema)

export type BudgetLimit = z.infer<typeof budgetLimitSchema>
export type BudgetLimitsResponse = z.infer<typeof budgetLimitsResponseSchema>

/** POST/PUT budgets 与 budget-limits 的 Item 响应 */
export const budgetItemResponseSchema = z
  .object({
    data: budgetSchema,
  })
  .passthrough()

export const budgetLimitItemResponseSchema = z
  .object({
    data: budgetLimitSchema,
  })
  .passthrough()

export type BudgetItemResponse = z.infer<typeof budgetItemResponseSchema>
export type BudgetLimitItemResponse = z.infer<typeof budgetLimitItemResponseSchema>

export const budgetWithLimitResponseSchema = z.object({
  data: z.object({
    attributes: z.object({ budget_id: z.string(), budget_limit_id: z.string() }),
  }),
})
export type BudgetWithLimitResponse = z.infer<typeof budgetWithLimitResponseSchema>

/**
 * GET /api/v1/bills（预算与订阅页「订阅」tab）。
 * 字段核对自 firefly-iii/app/Transformers/BillTransformer.php。当前测试环境无订阅数据。
 */
export const billAttributesSchema = z
  .object({
    name: z.string(),
    active: z.boolean().optional(),
    currency_symbol: z.string().optional(),
    currency_code: z.string().optional(),
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

export const billsResponseSchema = paginatedCollectionSchema(billSchema)

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
    currency_code: z.string().optional(),
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

export const piggyBanksResponseSchema = paginatedCollectionSchema(piggyBankSchema)

export type PiggyBank = z.infer<typeof piggyBankSchema>
export type PiggyBanksResponse = z.infer<typeof piggyBanksResponseSchema>

/** GET /api/v1/categories（设置页「分类与标签」组） */
export const categoryAttributesSchema = z.object({ name: z.string() }).passthrough()
export const categorySchema = z.object({ id: z.string(), attributes: categoryAttributesSchema }).passthrough()
export const categoriesResponseSchema = paginatedCollectionSchema(categorySchema)

export type Category = z.infer<typeof categorySchema>
export type CategoriesResponse = z.infer<typeof categoriesResponseSchema>

/** GET /api/v1/tags（设置页「分类与标签」组）：标签名字段是 attributes.tag，非 name（实测确认） */
export const tagAttributesSchema = z.object({ tag: z.string() }).passthrough()
export const tagSchema = z.object({ id: z.string(), attributes: tagAttributesSchema }).passthrough()
export const tagsResponseSchema = paginatedCollectionSchema(tagSchema)

export type Tag = z.infer<typeof tagSchema>
export type TagsResponse = z.infer<typeof tagsResponseSchema>

/**
 * GET /api/v1/rules、GET /api/v1/recurrences（设置页「自动化」组）。
 * 测试环境两者均无数据，字段核对自 app/Transformers/RuleTransformer.php 与
 * RecurrenceTransformer.php 源码（均有 title/active 字段），未做实测响应校验。
 */
export const ruleAttributesSchema = z.object({ title: z.string(), active: z.boolean().optional() }).passthrough()
export const ruleSchema = z.object({ id: z.string(), attributes: ruleAttributesSchema }).passthrough()
export const rulesResponseSchema = paginatedCollectionSchema(ruleSchema)

export type Rule = z.infer<typeof ruleSchema>
export type RulesResponse = z.infer<typeof rulesResponseSchema>

export const ruleGroupAttributesSchema = z.object({ title: z.string(), active: z.boolean().optional() }).passthrough()
export const ruleGroupSchema = z.object({ id: z.string(), attributes: ruleGroupAttributesSchema }).passthrough()
export const ruleGroupsResponseSchema = paginatedCollectionSchema(ruleGroupSchema)
export type RuleGroup = z.infer<typeof ruleGroupSchema>
export type RuleGroupsResponse = z.infer<typeof ruleGroupsResponseSchema>

export const recurrenceRepetitionSchema = z
  .object({
    description: z.string().optional(),
    occurrences: z.array(z.string()).optional().default([]),
  })
  .passthrough()

export const recurrenceAttributesSchema = z
  .object({
    title: z.string(),
    active: z.boolean().optional(),
    first_date: z.string(),
    latest_date: z.string().nullable().optional(),
    repeat_until: z.string().nullable().optional(),
    nr_of_repetitions: z.number().nullable().optional(),
    repetitions: z.array(recurrenceRepetitionSchema).optional().default([]),
  })
  .passthrough()
export const recurrenceSchema = z.object({ id: z.string(), attributes: recurrenceAttributesSchema }).passthrough()
export const recurrencesResponseSchema = paginatedCollectionSchema(recurrenceSchema)

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
export const currenciesResponseSchema = paginatedCollectionSchema(currencySchema)

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
    attachment_upload_size: z.number().positive().optional(),
    attachment_mime_types: z.array(z.string()).optional(),
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

/**
 * GET /api/v1/chart/account/overview
 * 非 JSON:API：数组，每项是一条账户余额时间序列。
 * entries / pc_entries 的 key 为 Atom 时间戳，value 为余额字符串。
 * 响应不含 account id，仅 label（账户名）。
 *
 * PHP 空数组序列化为 JSON []（非 {}）；单币种下 pc_entries 恒为 []，
 * 必须先把空数组预处理成 {}，否则 z.record 100% 拒收。
 */
const chartEntriesRecord = z.preprocess(
  (v) => (Array.isArray(v) && v.length === 0 ? {} : v),
  z.record(z.string(), z.union([z.string(), z.number()])),
)

export const accountChartSeriesSchema = z
  .object({
    label: z.string(),
    currency_code: z.string().optional(),
    currency_symbol: z.string().optional(),
    type: z.string().optional(),
    period: z.string().optional(),
    entries: chartEntriesRecord,
    pc_entries: chartEntriesRecord.optional(),
  })
  .passthrough()

export const accountChartOverviewSchema = z.array(accountChartSeriesSchema)

export type AccountChartSeries = z.infer<typeof accountChartSeriesSchema>
export type AccountChartOverview = z.infer<typeof accountChartOverviewSchema>

/**
 * GET/POST/PUT /api/v1/preferences[/{name}]
 * Item 资源；attributes.data 可为任意 JSON（字符串/数字/布尔/数组/对象）。
 */
export const preferenceAttributesSchema = z
  .object({
    name: z.string(),
    data: z.unknown(),
  })
  .passthrough()

export const preferenceItemSchema = z
  .object({
    id: z.string(),
    attributes: preferenceAttributesSchema,
  })
  .passthrough()

export const preferenceResponseSchema = z
  .object({
    data: preferenceItemSchema,
  })
  .passthrough()

export type PreferenceItem = z.infer<typeof preferenceItemSchema>
export type PreferenceResponse = z.infer<typeof preferenceResponseSchema>
