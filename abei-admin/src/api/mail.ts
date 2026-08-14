import { apiDeleteJson, apiDownload, apiGet, apiPatch, apiPost } from './client'

export type MailClassification = 'unclassified' | 'matched' | 'ignored' | 'error'
export type MailTextField =
  | 'from'
  | 'to'
  | 'subject'
  | 'folder'
  | 'header'
  | 'body_text'
  | 'body_html'
  | 'attachment_filename'
  | 'attachment_extension'
  | 'attachment_mime'
export type MailTextOperator = 'equals' | 'contains' | 'prefix' | 'suffix' | 'domain'

export type MailRuleCondition =
  | { type: 'all' | 'any'; conditions: MailRuleCondition[] }
  | { type: 'not'; condition: MailRuleCondition }
  | {
      type: 'text'
      field: MailTextField
      operator: MailTextOperator
      value: string
      header_name?: string
    }
  | { type: 'attachment_count'; operator: 'equals' | 'at_least' | 'at_most'; value: number }

export interface MailAttachment {
  filename: string
  mime: string
  size: number
}

export interface MailMessageSummary {
  id: string
  type: 'mail-message'
  attributes: {
    folder: string
    uid_validity: number
    uid: number
    message_id: string | null
    from_address: string | null
    to_addresses: string[]
    subject: string | null
    received_at: string | null
    body_structure: {
      has_text?: boolean
      has_html?: boolean
      attachments?: MailAttachment[]
    }
    content_state: 'metadata_only' | 'cached' | 'expired' | 'unavailable'
    classification: MailClassification
    matched_rule_id: string | null
    matched_rule_version: number | null
    channel_key: string | null
    parser_flow_id: string | null
    legacy_channel_key: string | null
    created_at: string
    updated_at: string
  }
}

export interface MailDiagnostic {
  rule_id: string
  rule_name: string
  version: number
  selected: boolean
  diagnostic: {
    kind: string
    matched: boolean
    reason: string
    children?: Array<{ kind: string; matched: boolean; reason: string }>
  }
}

export interface MailMessageDetail extends MailMessageSummary {
  attributes: MailMessageSummary['attributes'] & {
    headers: {
      normalized?: Record<string, string[]>
      raw?: string
    }
    match_diagnostics: MailDiagnostic[]
    preview: {
      available: boolean
      text?: string | null
      html?: string | null
      truncated?: boolean
    }
  }
}

export interface MailRule {
  id: string
  type: 'mail-rule'
  attributes: {
    name: string
    enabled: boolean
    position: number
    current_version: number | null
    draft: {
      conditions: MailRuleCondition
      channel_key: string
      parser_flow_id: string | null
    }
    published: {
      conditions: MailRuleCondition | null
      channel_key: string | null
      parser_flow_id: string | null
      checksum: string | null
    }
    created_at: string
    updated_at: string
  }
}

export interface MailRuleInput {
  name: string
  enabled: boolean
  position: number
  channel_key: string
  parser_flow_id: number | null
  conditions: MailRuleCondition
}

export interface MailSyncRun {
  id: string
  kind: 'incremental' | 'rescan'
  scope: Record<string, unknown>
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  stage: string
  counts: {
    scanned: number
    fetched: number
    matched: number
    unclassified: number
    failed: number
  }
  progress: Record<string, unknown>
  error_summary: string | null
  requested_at: string
  started_at: string | null
  finished_at: string | null
  updated_at: string
}

export interface MailSample {
  id: string
  name: string
  purpose: 'rule' | 'parser' | 'negative'
  pinned_at: string
  message: {
    id: string
    subject: string | null
    from_address: string | null
    received_at: string | null
  }
}

interface Collection<T> {
  data: T[]
  meta?: { pagination?: { total: number; limit: number; offset: number } }
}

interface Item<T> {
  data: T
}

export function getMailMessages(params: {
  classification?: MailClassification
  search?: string
  limit?: number
  offset?: number
} = {}): Promise<Collection<MailMessageSummary>> {
  return apiGet('/v1/mail-messages', params)
}

export function getMailMessage(id: string): Promise<Item<MailMessageDetail>> {
  return apiGet(`/v1/mail-messages/${id}`)
}

export function getMailRules(): Promise<Collection<MailRule>> {
  return apiGet('/v1/mail-rules')
}

export function createMailRule(input: MailRuleInput): Promise<Item<MailRule>> {
  return apiPost('/v1/mail-rules', input)
}

export function updateMailRule(id: string, input: MailRuleInput): Promise<Item<MailRule>> {
  return apiPatch(`/v1/mail-rules/${id}`, input)
}

export function testMailRule(input: {
  conditions: MailRuleCondition
  message_ids?: number[]
  limit?: number
}): Promise<{
  data: {
    tested: number
    matched: number
    requires_body: boolean
    samples: Array<{ id: string; subject: string | null; from_address: string | null; received_at: string | null }>
  }
}> {
  return apiPost('/v1/mail-rules/test', input)
}

export function publishMailRule(id: string): Promise<Item<MailRule>> {
  return apiPost(`/v1/mail-rules/${id}/publish`, {}, { confirm: true })
}

export function rerouteMailMessage(id: string): Promise<Item<MailMessageDetail>> {
  return apiPost(`/v1/mail-messages/${id}/reroute`, {})
}

export function cacheMailMessage(id: string): Promise<Item<MailMessageDetail>> {
  return apiPost(`/v1/mail-messages/${id}/cache`, {})
}

export function syncMailbox(limit = 100): Promise<{
  data: { attributes: { run_id?: string; status: string; requested_at: string } }
}> {
  return apiPost('/v1/mailboxes/current/sync', { limit })
}

export interface MailboxRescanInput {
  from: string
  to: string
  limit: number
}

export function estimateMailboxRescan(input: MailboxRescanInput): Promise<{
  dry_run: true
  data: MailboxRescanInput & { estimated: number }
}> {
  return apiPost('/v1/mailboxes/current/rescan', input, { dry_run: true })
}

export function startMailboxRescan(input: MailboxRescanInput): Promise<{
  data: {
    type: 'mail-sync-run'
    id: string
    attributes: { status: 'queued'; kind: 'rescan' }
  }
}> {
  return apiPost('/v1/mailboxes/current/rescan', input, { confirm: true })
}

export function getMailSyncRuns(limit = 30): Promise<Collection<MailSyncRun>> {
  return apiGet('/v1/mail-sync-runs', { limit })
}

export function cancelMailSyncRun(id: string): Promise<Item<MailSyncRun>> {
  return apiPost(`/v1/mail-sync-runs/${id}/cancel`, {})
}

export function getMailSamples(): Promise<Collection<MailSample>> {
  return apiGet('/v1/mail-samples')
}

export function createMailSample(input: {
  mail_message_id: number
  name: string
  purpose: MailSample['purpose']
}): Promise<{ data: { id: string } }> {
  return apiPost('/v1/mail-samples', input)
}

export async function downloadRawMail(id: string): Promise<void> {
  const { blob, filename } = await apiDownload(`/v1/mail-messages/${id}/raw`)
  const url = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename ?? `mail-${id}.eml`
    anchor.click()
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function deleteMailSample(id: string): Promise<unknown> {
  return apiDeleteJson(`/v1/mail-samples/${id}`, {}, { confirm: true })
}

/** 一个邮箱在窗口期内的处理结果。管理视角用，解析失败多的排在前面。 */
export interface AdminProcessingMailbox {
  user_id: string
  user_email: string | null
  mailbox_email: string | null
  enabled: boolean
  runs: number
  failed_runs: number
  matched: number
  parse_total: number
  parse_failed: number
  parse_waiting_input: number
  last_requested_at: string | null
  last_status: string | null
}

/**
 * GET /v1/admin/processing-summary —— 和用户端同一份账，按邮箱铺开。
 * owner 才拿得到；用来一眼看出谁的解析卡住了。
 */
export function getAdminProcessingSummary(
  days?: number,
): Promise<{ window_days: number; mailboxes: AdminProcessingMailbox[] }> {
  return apiGet('/v1/admin/processing-summary', days ? { days } : undefined)
}
