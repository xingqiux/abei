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

export const transactionsResponseSchema = paginatedCollectionSchema(transactionGroupSchema).extend({
  next_before_id: z.string().nullable().optional(),
})

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

/** 四状态计数。tab 上的数字和渠道条上的数字共用这个形状。 */
export const billRowGroupCountsSchema = z.object({
  importable: z.number(),
  attention: z.number(),
  dismissed: z.number(),
  imported: z.number(),
})

export type BillRowGroupCounts = z.infer<typeof billRowGroupCountsSchema>

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
    /** 渠道 × 四状态的分桶，和列表用同一套口径。老响应没有，缺省当全 0。 */
    counts: billRowGroupCountsSchema.optional(),
  })
  .passthrough()

/**
 * 全站唯一待办口径（设计稿 02 §3）。侧栏 badge、今天页管线条、收件箱页头
 * 都只读这一个对象，不再各算各的。
 *
 * 后端补齐前老响应里没有这个字段，所以是 optional：调用方拿 `todo ?? EMPTY_TODO`。
 */
export const billInboxTodoSchema = z
  .object({
    importable: z.number(),
    attention: z.number(),
    stuck_tasks: z.number(),
    total: z.number(),
  })
  .passthrough()

export type BillInboxTodo = z.infer<typeof billInboxTodoSchema>

export const EMPTY_BILL_INBOX_TODO: BillInboxTodo = {
  importable: 0,
  attention: 0,
  stuck_tasks: 0,
  total: 0,
}

export const billMailboxSyncResultSchema = z
  .object({
    scanned: z.number(),
    fetched: z.number().optional(),
    matched: z.number().optional(),
    unclassified: z.number().optional(),
    created: z.number(),
    ignored: z.number(),
    duplicates: z.number(),
    failed: z.number(),
    processed: z.number(),
    process_failed: z.number(),
    errors: z.array(z.string()).optional(),
  })
  .passthrough()

export const billMailboxSyncStateSchema = z
  .object({
    status: z.enum(['idle', 'queued', 'running', 'succeeded', 'failed']),
    requested_at: z.string().nullable(),
    started_at: z.string().nullable(),
    finished_at: z.string().nullable(),
    result: billMailboxSyncResultSchema.nullable(),
    error_message: z.string().nullable(),
  })
  .passthrough()

export type BillMailboxSyncResult = z.infer<typeof billMailboxSyncResultSchema>
export type BillMailboxSyncState = z.infer<typeof billMailboxSyncStateSchema>

export const billInboxSummarySchema = z
  .object({
    pending_total: z.number(),
    needs_code: z.number(),
    unprocessed: z.number(),
    failed: z.number(),
    unclassified_mail: z.number().optional().default(0),
    channels: z.array(billInboxChannelSchema),
    /** 四个状态 tab 的数字。老响应没有，缺省当全 0。 */
    counts: billRowGroupCountsSchema.optional(),
    todo: billInboxTodoSchema.optional(),
    mailbox_sync: billMailboxSyncStateSchema.optional(),
  })
  .passthrough()

export type BillInboxSummary = z.infer<typeof billInboxSummarySchema>

/** 一条卡住的解析任务：失败了要重试，或者在等账单密码。 */
export const billProcessingStuckJobSchema = z
  .object({
    job_id: z.string(),
    document_id: z.string(),
    status: z.string(),
    error_code: z.string().nullable().optional(),
    error_message: z.string().nullable().optional(),
    waiting_reason: z.string().nullable().optional(),
    updated_at: z.string(),
    channel_key: z.string(),
    summary: z.string().nullable().optional(),
  })
  .passthrough()

export type BillProcessingStuckJob = z.infer<typeof billProcessingStuckJobSchema>

/** 最近一段时间的处理结果：收了多少信、解析成了几封、产出多少行。 */
export const billProcessingSummarySchema = z
  .object({
    window_days: z.number(),
    mail: z
      .object({
        runs: z.number(),
        scanned: z.number(),
        fetched: z.number(),
        matched: z.number(),
        unclassified: z.number(),
        failed_runs: z.number(),
        running_runs: z.number(),
        last_run: z
          .object({
            id: z.string(),
            status: z.string(),
            stage: z.string(),
            error_summary: z.string().nullable().optional(),
            requested_at: z.string(),
            finished_at: z.string().nullable().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough(),
    parse: z
      .object({
        total: z.number(),
        succeeded: z.number(),
        failed: z.number(),
        waiting_input: z.number(),
        running: z.number(),
        stuck: z.array(billProcessingStuckJobSchema),
      })
      .passthrough(),
    rows: z
      .object({
        produced: z.number(),
        importable: z.number(),
        attention: z.number(),
      })
      .passthrough(),
  })
  .passthrough()

export type BillProcessingSummary = z.infer<typeof billProcessingSummarySchema>

export const billInboxSettingsSchema = z.object({
  data: z.object({
    type: z.string(),
    attributes: z.object({
      enabled: z.boolean(),
      provider: z.enum(['gmail', 'imap']),
      auth_method: z.enum(['google_oauth', 'password']),
      email: z.string(),
      host: z.string(),
      port: z.number(),
      encryption: z.enum(['none', 'ssl', 'tls', 'starttls']),
      username: z.string(),
      folder: z.string(),
      has_password: z.boolean(),
      google_connected: z.boolean(),
      google_oauth_available: z.boolean(),
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

export const googleOAuthStartSchema = z.object({
  data: z.object({
    type: z.literal('google-oauth'),
    attributes: z.object({ authorization_url: z.url() }),
  }),
})

export type GoogleOAuthStart = z.infer<typeof googleOAuthStartSchema>
export type BillInboxProcessResult = z.infer<typeof billInboxProcessResultSchema>
export type BillInboxCleanupResult = z.infer<typeof billInboxCleanupResultSchema>

/** GET /v1/bills 的兼容任务状态枚举。 */
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
    account_hint: z.string().nullable().optional(),
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

/**
 * GET /v1/bills/{id}/rows 的行状态/去重状态枚举。
 * `dismissed`（已忽略）是设计稿 02 §2 新增的终态：不计待办、不可入账、可恢复为 pending。
 */
export const billRowStatusSchema = z.enum(['pending', 'imported', 'failed', 'needs_split', 'split', 'dismissed'])
export const billRowDuplicateStateSchema = z.enum(['unique', 'duplicate', 'conflict'])

export type BillRowStatus = z.infer<typeof billRowStatusSchema>
export type BillRowDuplicateState = z.infer<typeof billRowDuplicateStateSchema>

export const billImportAttemptStatusSchema = z.enum([
  'prepared',
  'sending',
  'succeeded',
  'rejected',
  'retryable',
  'uncertain',
  'reconciled',
])

export const billImportAttemptSummarySchema = z
  .object({
    id: z.string(),
    status: billImportAttemptStatusSchema,
    error_code: z.string().nullable().optional(),
    error_message: z.string().nullable().optional(),
    retry_after: z.string().nullable().optional(),
    transaction_group_id: z.union([z.string(), z.number()]).nullable().optional(),
    updated_at: z.string().nullable().optional(),
  })
  .passthrough()

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
    account_hint: z.string().nullable().optional(),
    source_account_id: z.union([z.string(), z.number()]).nullable().optional(),
    source_name: z.string().nullable().optional(),
    destination_account_id: z.union([z.string(), z.number()]).nullable().optional(),
    destination_name: z.string().nullable().optional(),
    category_name: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    tags: z.array(z.string()).nullable().optional(),
    transaction_group_id: z.union([z.string(), z.number()]).nullable().optional(),
    error_message: z.string().nullable().optional(),
    issues: z.array(z.record(z.string(), z.unknown())).optional(),
    import_attempt: billImportAttemptSummarySchema.nullable().optional(),
    /** 非空表示这个值是 AI 建议的（目前只有 'ai'）；人改过后端会清空。 */
    suggested_by: z.string().nullable().optional(),
    user_modified_at: z.string().nullable().optional(),
    /** duplicate_auto / zero_amount / task_archived / user */
    dismissed_reason: z.string().nullable().optional(),
    dismissed_at: z.string().nullable().optional(),
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

/**
 * GET /api/v1/bill-rows（设计稿 02 §3）：跨任务、跨渠道的流水队列。
 * 行体是现有 bill statement row，额外挂 group / reasons / task（来源凭证）。
 */
export const billRowGroupSchema = z.enum(['importable', 'attention', 'dismissed', 'imported'])
export type BillRowGroup = z.infer<typeof billRowGroupSchema>

export const billRowTaskRefSchema = z
  .object({
    id: z.string(),
    source: z.string(),
    summary: z.string().nullable().optional(),
    received_at: z.string().nullable().optional(),
  })
  .passthrough()

export type BillRowTaskRef = z.infer<typeof billRowTaskRefSchema>

export const billQueueRowAttributesSchema = billStatementRowAttributesSchema.extend({
  group: billRowGroupSchema.optional(),
  /** 进入「待确认」的中文理由，可能不止一条 */
  reasons: z.array(z.string()).optional(),
  task: billRowTaskRefSchema.nullable().optional(),
})

export const billQueueRowSchema = z
  .object({
    id: z.string(),
    attributes: billQueueRowAttributesSchema,
  })
  .passthrough()

export const billRowsResponseSchema = paginatedCollectionSchema(billQueueRowSchema)

export type BillQueueRow = z.infer<typeof billQueueRowSchema>
export type BillRowsResponse = z.infer<typeof billRowsResponseSchema>

/**
 * GET /v1/bill-rows/{id}/links：这一行和别的行可能是同一件事。
 * suggested 是算出来的建议，confirmed 是人确认过的（重复的那一侧已经被忽略掉了）。
 */
export const billRowLinkSchema = z
  .object({
    id: z.string(),
    attributes: z
      .object({
        row_id: z.string(),
        relation: z.string(),
        state: z.enum(['suggested', 'confirmed', 'rejected']),
        confidence: z.string(),
        evidence: z.record(z.string(), z.unknown()).nullable().optional(),
        decided_at: z.string().nullable().optional(),
        related_row: z
          .object({
            id: z.string(),
            status: z.string(),
            occurred_at: z.string().nullable().optional(),
            signed_amount: z.string(),
            currency_code: z.string().nullable().optional(),
            description: z.string().nullable().optional(),
            counterparty: z.string().nullable().optional(),
            source_name: z.string().nullable().optional(),
            destination_name: z.string().nullable().optional(),
            channel_key: z.string().nullable().optional(),
            dismissed_reason: z.string().nullable().optional(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough()

export const billRowLinksResponseSchema = z.object({ data: z.array(billRowLinkSchema) })
export type BillRowLink = z.infer<typeof billRowLinkSchema>

/** POST /api/v1/bill-rows/dismiss | restore 响应：只关心处理条数 */
export const billRowsBulkResultSchema = z
  .object({
    processed: z.number().optional(),
  })
  .passthrough()

export type BillRowsBulkResult = z.infer<typeof billRowsBulkResultSchema>

/** PATCH /v1/bill-rows/{id} 响应：单条 Item。 */
export const billStatementRowItemResponseSchema = z
  .object({
    data: billStatementRowSchema,
  })
  .passthrough()

export type BillStatementRowItemResponse = z.infer<typeof billStatementRowItemResponseSchema>

/** POST /v1/bills/{id}/import 与 /v1/bill-rows/import 响应。 */
export const billImportRowResultSchema = z
  .object({
    row_id: z.string(),
    row_number: z.number().optional(),
    status: z.string(),
    action: z.enum(['would_import', 'skip', 'imported', 'failed', 'retryable', 'uncertain']).optional(),
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
    attempt_id: z.string().nullable().optional(),
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
        retryable: z.number().optional().default(0),
        uncertain: z.number().optional().default(0),
        would_import: z.number().optional().default(0),
      })
      .passthrough(),
    rows: z.array(billImportRowResultSchema),
    balance_chain: z.array(z.unknown()).optional(),
    dry_run: z.boolean().optional(),
  })
  .passthrough()

export type BillImportRowResult = z.infer<typeof billImportRowResultSchema>
export type BillImportResponse = z.infer<typeof billImportResponseSchema>

export const billImportAttemptSchema = billImportAttemptSummarySchema.extend({
  bill_row_id: z.string(),
  attempt_no: z.number(),
  external_id: z.string(),
  payload_hash: z.string(),
  payload: z.unknown(),
  firefly_status: z.number().nullable().optional(),
  created_at: z.string(),
  finished_at: z.string().nullable().optional(),
})

export const billImportAttemptResponseSchema = z
  .object({
    data: billImportAttemptSchema,
    match_count: z.number().optional(),
  })
  .passthrough()

export type BillImportAttempt = z.infer<typeof billImportAttemptSchema>
export type BillImportAttemptResponse = z.infer<typeof billImportAttemptResponseSchema>

export const billAccountMappingSchema = z
  .object({
    id: z.string(),
    type: z.string().optional(),
    attributes: z
      .object({
        channel_key: z.string(),
        account_hint: z.string(),
        firefly_account_id: z.string(),
        firefly_account_name: z.string(),
        firefly_account_type: z.string().nullable().optional(),
        source: z.string(),
        last_verified_at: z.string().nullable().optional(),
        created_at: z.string(),
        updated_at: z.string(),
      })
      .passthrough(),
  })
  .passthrough()

export const billAccountMappingsResponseSchema = z
  .object({ data: z.array(billAccountMappingSchema) })
  .passthrough()

export const billAccountMappingResponseSchema = z
  .object({ data: billAccountMappingSchema })
  .passthrough()

export type BillAccountMapping = z.infer<typeof billAccountMappingSchema>
export type BillAccountMappingsResponse = z.infer<typeof billAccountMappingsResponseSchema>
export type BillAccountMappingResponse = z.infer<typeof billAccountMappingResponseSchema>

/** POST /api/v1/bill-inbox/sync：只排队，结果由 summary 里的 mailbox_sync 返回。 */
export const billInboxSyncResultSchema = z
  .object({
    data: z
      .object({
        type: z.string().optional(),
        attributes: billMailboxSyncStateSchema,
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
 * GET /api/v1/categories（分类管理页）。
 *
 * v0.2 起每个分类必属一个域，域内两级（组 → 子分类）：
 * - domain：income / expense / transfer，决定分类落在管理页哪一段、进不进收支统计。
 * - parent_id：为空是组（或本身就是叶子），有值是某个组的子分类。
 * - system：出厂词表带的，不可删不可改名，但可禁用、可换图标颜色。
 * - color：存色板号 "1"~"12"，不存 hex——深浅主题各有一套 --cat-N，存死了就跟不了主题。
 * - disabled_at：禁用时间戳。禁用的分类默认不返回，要带 ?include_disabled=1。
 *
 * 旧数据里没有 domain 的记录一律当支出，别让一个缺字段把整页打挂。
 */
export const categoryDomainSchema = z.enum(['income', 'expense', 'transfer'])
export type CategoryDomain = z.infer<typeof categoryDomainSchema>

export const CATEGORY_DOMAINS: readonly CategoryDomain[] = ['income', 'expense', 'transfer']

export const categoryAttributesSchema = z
  .object({
    name: z.string(),
    domain: categoryDomainSchema.catch('expense').default('expense'),
    parent_id: z.union([z.string(), z.number()]).nullable().optional(),
    system: z.boolean().nullable().optional(),
    icon: z.string().nullable().optional(),
    color: z.string().nullable().optional(),
    disabled_at: z.string().nullable().optional(),
  })
  .passthrough()
export const categorySchema = z.object({ id: z.string(), attributes: categoryAttributesSchema }).passthrough()
export const categoriesResponseSchema = paginatedCollectionSchema(categorySchema)
export const categoryItemResponseSchema = z.object({ data: categorySchema }).passthrough()

export type Category = z.infer<typeof categorySchema>
export type CategoriesResponse = z.infer<typeof categoriesResponseSchema>
export type CategoryItemResponse = z.infer<typeof categoryItemResponseSchema>

/**
 * GET /api/v1/abei/category-stats —— 管理页每行的「近一年笔数 / 最后使用」。
 * 单独一个端点而不是塞进分类列表：统计要扫交易表，跟词表本身的读写节奏不一样。
 * uncategorized_count 是没挂分类的交易数（Firefly 原生状态），管理页拿它渲染虚拟的「未分类」行。
 */
export const categoryStatEntrySchema = z
  .object({
    id: z.string(),
    txn_count_365d: z.number(),
    last_used_at: z.string().nullable(),
  })
  .passthrough()

export const categoryStatsSchema = z
  .object({
    uncategorized_count: z.number(),
    categories: z.array(categoryStatEntrySchema),
  })
  .passthrough()

export const categoryStatsResponseSchema = z.object({ data: categoryStatsSchema }).passthrough()

export type CategoryStatEntry = z.infer<typeof categoryStatEntrySchema>
export type CategoryStats = z.infer<typeof categoryStatsSchema>

/**
 * GET /api/v1/abei/budget-groups?start=&end= —— 按支出域的「组」设预算。
 * amount 为空表示这一组还没设预算；spent 是该组全部子分类在期内的交易合计，
 * 不依赖逐笔挂 budget_id。
 */
export const budgetGroupSchema = z
  .object({
    category_id: z.string(),
    name: z.string(),
    icon: z.string().nullable(),
    color: z.string().nullable(),
    amount: z.string().nullable(),
    spent: z.string(),
    currency_code: z.string(),
  })
  .passthrough()

export const budgetGroupsResponseSchema = z.object({ data: z.array(budgetGroupSchema) }).passthrough()

export type BudgetGroup = z.infer<typeof budgetGroupSchema>

/**
 * GET /api/ai/category-rules（abei-agent）—— 「已学会的规则」。
 * 规则只从用户纠正衍生，界面上只能看和停用，没有编辑器。
 * origin=correction 是用户纠正学来的，manual 是人手立的。
 */
export const categoryRuleSchema = z
  .object({
    id: z.string(),
    pattern_type: z.enum(['merchant', 'keyword']).catch('merchant'),
    pattern: z.string(),
    category_name: z.string(),
    origin: z.enum(['correction', 'manual']).catch('correction'),
    enabled: z.boolean(),
    hit_count: z.number().nullable().optional(),
    created_at: z.string().nullable().optional(),
    last_hit_at: z.string().nullable().optional(),
    /** 目标分类被删时规则自动停用，这里放一句人话原因 */
    disabled_reason: z.string().nullable().optional(),
  })
  .passthrough()

export const categoryRulesResponseSchema = z.object({ data: z.array(categoryRuleSchema) }).passthrough()
export const categoryRuleItemResponseSchema = z.object({ data: categoryRuleSchema }).passthrough()

export type CategoryRule = z.infer<typeof categoryRuleSchema>

/**
 * GET /api/ai/vocab-suggestions —— AI 对词表说话的唯一方式：只建议，不自动改。
 * action=enable 是「把这个已禁用的默认分类打开」（category_id 必有）；
 * action=create 是「新建一个分类」（category_id 为空，用 name/parent_id 建）。
 * 用户点同意时前端先落词表再回报 accept，后端不代劳。
 */
export const vocabSuggestionSchema = z
  .object({
    id: z.string(),
    action: z.enum(['enable', 'create']).catch('create'),
    domain: categoryDomainSchema.catch('expense'),
    /** action=enable 时指向要启用的分类；create 时为空 */
    category_id: z.string().nullable().optional(),
    name: z.string(),
    parent_id: z.string().nullable().optional(),
    parent_name: z.string().nullable().optional(),
    icon: z.string().nullable().optional(),
    color: z.string().nullable().optional(),
    /** 一句人话理由，如「最近 6 笔宠物用品都落在杂项」 */
    reason: z.string().nullable().optional(),
    sample_count: z.number().nullable().optional(),
    samples: z.array(z.string()).nullable().optional(),
    status: z.enum(['pending', 'accepted', 'ignored']).catch('pending'),
    created_at: z.string().nullable().optional(),
  })
  .passthrough()

export const vocabSuggestionsResponseSchema = z
  .object({ data: z.array(vocabSuggestionSchema) })
  .passthrough()

export type VocabSuggestion = z.infer<typeof vocabSuggestionSchema>

/**
 * GET /api/ai/backfill/suggestions —— 未分类交易的待确认建议。
 * 引擎只写建议不改分类；source=rule 是规则命中（不花钱），model 是模型给的。
 */
export const backfillSuggestionSchema = z
  .object({
    journal_id: z.string(),
    transaction_group_id: z.string().nullable().optional(),
    date: z.string(),
    description: z.string(),
    amount: z.string(),
    currency_code: z.string().nullable().optional(),
    category_id: z.string().nullable().optional(),
    category_name: z.string(),
    source: z.enum(['rule', 'model']).catch('model'),
    created_at: z.string().nullable().optional(),
  })
  .passthrough()

export const backfillSuggestionsResponseSchema = z
  .object({ data: z.array(backfillSuggestionSchema) })
  .passthrough()

export type BackfillSuggestion = z.infer<typeof backfillSuggestionSchema>

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
    type: z.string().optional(),
    moment: z.string().optional(),
    skip: z.number().optional(),
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
    // Firefly 把交易模板放在 attributes.transactions 里。
    // 这里曾经写成 transactions（那个键不存在，实测返回 null），
    // 于是订阅行永远显示「未配置账户模板」和「—」。单测夹具当时也照着错的键名编，
    // 所以测试全绿而真实数据是坏的——改键名时连夹具一起改。
    transactions: z
      .array(
        z
          .object({
            amount: z.string().optional(),
            currency_symbol: z.string().optional(),
            currency_code: z.string().optional(),
            source_name: z.string().optional(),
            destination_name: z.string().optional(),
            category_name: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .optional()
      .default([]),
  })
  .passthrough()
export const recurrenceSchema = z.object({ id: z.string(), attributes: recurrenceAttributesSchema }).passthrough()
export const recurrencesResponseSchema = paginatedCollectionSchema(recurrenceSchema)

export type Recurrence = z.infer<typeof recurrenceSchema>
export type RecurrencesResponse = z.infer<typeof recurrencesResponseSchema>

/** GET /api/v1/tokens（个人访问令牌列表，本项目后端新增端点） */
export const apiTokenSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    created_at: z.string().nullable(),
    expires_at: z.string().nullable(),
    current: z.boolean(),
  })
  .passthrough()
export const apiTokensResponseSchema = z.object({ data: z.array(apiTokenSchema) })
export type ApiToken = z.infer<typeof apiTokenSchema>

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
