/**
 * 账单文档：一封账单邮件被解析成账单行的那条记录。
 *
 * 后台此前完全没接这套端点，解析失败在界面上只有一个聚合数字、点不进去；
 * 「哪封邮件、卡在哪一步、报了什么错、能不能重来」全靠翻服务端日志。
 * 这个模块就是把那些信息接出来。
 *
 * 字段名照抄服务端（billing/store.rs 的 document_json 等），不在这层改名——
 * 中间再翻译一道，出问题时对不上服务端日志。
 */
import { apiDownload, apiGet, apiPost } from './client'

/**
 * 文档状态。服务端由 SQL 现算，取值就这几个：
 * - `received` 收下了还没开始解析
 * - `ready` 正在解析
 * - `parsed` 解析完成
 * - `needs_secret` 卡在等密码
 * - `failed` 解析失败
 * - `imported` 行已全部入账
 * - `ignored` 文档已归档
 */
export type BillDocumentStatus =
  | 'received'
  | 'ready'
  | 'parsed'
  | 'needs_secret'
  | 'failed'
  | 'imported'
  | 'ignored'

/**
 * 可以拿去筛选的状态。
 *
 * 少一个 `imported`：服务端的筛选 SQL 里没有这一支，传过去会一封都匹配不到。
 * 已入账的文档在列表里显示为「已入账」，但只能用「已解析」筛出来。
 */
export const FILTERABLE_DOCUMENT_STATUSES = [
  'received',
  'ready',
  'parsed',
  'needs_secret',
  'failed',
  'ignored',
] as const

export type FilterableDocumentStatus = (typeof FILTERABLE_DOCUMENT_STATUSES)[number]

export interface BillDocumentRowCounts {
  total: number
  pending: number
  imported: number
  duplicate: number
  conflict: number
}

export interface BillDocument {
  id: string
  type: 'bill-document'
  attributes: {
    source: string
    channel_key: string
    subject: string | null
    parser_flow_id: string
    parser_flow_version: number
    active_revision: number | null
    lifecycle: 'active' | 'archived' | string
    status: BillDocumentStatus | string
    received_at: string | null
    summary: string | null
    account_hint: string | null
    period_start: string | null
    period_end: string | null
    current_secret_challenge_id: string | null
    error_code: string | null
    error_message: string | null
    metadata: {
      parse_job_id?: string | null
      parse_stage?: string | null
      parse_progress?: unknown
      waiting_reason?: string | null
    }
    row_counts: BillDocumentRowCounts
    created_at: string
    updated_at: string
  }
}

/** 服务端是页码分页（page 从 1 起），不是 offset。别照着邮件列表那套写。 */
export interface DocumentPagination {
  total: number
  count: number
  per_page: number
  current_page: number
  total_pages: number
}

export interface BillDocumentEvent {
  id: string
  type: 'bill-task-event'
  attributes: {
    bill_document_id: string
    parse_job_id: string
    /** `parse_job_` + 任务状态，例如 `parse_job_failed`。 */
    event_type: string
    message: string
    metadata: {
      status?: string | null
      stage?: string | null
      progress?: unknown
      waiting_reason?: string | null
      error_code?: string | null
      requested_at?: string | null
      started_at?: string | null
      finished_at?: string | null
    }
    created_at: string
  }
}

export interface BillDocumentArtifact {
  id: string
  type: 'bill-artifact'
  attributes: {
    bill_document_id: string
    revision: number
    parent_artifact_id: string | null
    kind: string
    filename: string
    checksum: string
    size: number
    encrypted: boolean
    mime_type: string
    generation_stage: string
    /** 服务端给的下载路径，要带令牌请求，不能直接塞进 `<a href>`。 */
    download_url: string
    created_at: string
  }
}

/** 修订是扁的，没有 id/type/attributes 那层壳——服务端就是这么发的。 */
export interface BillDocumentRevision {
  revision: number
  parse_job_id: string
  parser_flow_id: string
  parser_flow_version: number
  valid_row_count: number
  invalid_row_count: number
  amount_totals: unknown
  warnings: unknown
  metrics: unknown
  created_at: string
}

export interface BillDocumentList {
  data: BillDocument[]
  meta?: { pagination?: DocumentPagination }
}

/**
 * 文档列表。
 *
 * 服务端对查询串是 `deny_unknown_fields`，多带一个键就是 400，所以这里只放它认识的四个。
 * `limit` 服务端限死 1..=200。
 */
export function getBillDocuments(params: {
  channel?: string
  status?: FilterableDocumentStatus
  page?: number
  limit?: number
} = {}): Promise<BillDocumentList> {
  return apiGet('/v1/bill-documents', {
    ...(params.channel ? { channel: params.channel } : {}),
    ...(params.status ? { status: params.status } : {}),
    page: params.page ?? 1,
    limit: params.limit ?? 50,
  })
}

export function getBillDocument(id: string): Promise<{ data: BillDocument }> {
  return apiGet(`/v1/bill-documents/${id}`)
}

export function getBillDocumentEvents(id: string): Promise<{ data: BillDocumentEvent[] }> {
  return apiGet(`/v1/bill-documents/${id}/events`)
}

export function getBillDocumentArtifacts(id: string): Promise<{ data: BillDocumentArtifact[] }> {
  return apiGet(`/v1/bill-documents/${id}/artifacts`)
}

export function getBillDocumentRevisions(id: string): Promise<{ data: BillDocumentRevision[] }> {
  return apiGet(`/v1/bill-documents/${id}/revisions`)
}

/**
 * 重新解析。返回 202 和新排的解析任务，不是解析结果——界面要说「已排队」，别说「已完成」。
 * 这个端点不吃 `confirm` 闸门（服务端没设），多带反而没必要。
 */
export function reparseBillDocument(
  id: string,
  version?: number,
): Promise<{ data: { id: string; status: string; target_revision: number } }> {
  return apiPost(`/v1/bill-documents/${id}/reparse`, version ? { version } : {})
}

/** 产物下载。要带 Authorization，所以走 fetch + blob，不能用裸链接。 */
export async function downloadBillArtifact(artifact: BillDocumentArtifact): Promise<void> {
  const { blob, filename } = await apiDownload(artifact.attributes.download_url)
  const url = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename ?? artifact.attributes.filename
    anchor.click()
  } finally {
    URL.revokeObjectURL(url)
  }
}
