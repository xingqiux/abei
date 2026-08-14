import { apiDeleteJson, apiGet, apiPatch, apiPost, apiPostForm } from './client'

export interface ParserNode {
  id: string
  enabled?: boolean
  type: string
  [key: string]: unknown
}

export interface ParserFlowDefinition {
  schema_version: number
  channel_key: string
  statement_kind?: string | null
  nodes: ParserNode[]
  output?: { require?: string[] }
}

export interface ParserFlowSummary {
  id: string
  type: 'parser-flow'
  attributes: {
    owner: 'system' | 'user'
    name: string
    slug: string
    status: 'draft' | 'published' | 'retired'
    current_version: number | null
    cloned_from_flow_id: string | null
    published_checksum: string | null
    channel_key: string | null
    published_at: string | null
    updated_at: string
  }
}

export interface ParserTestCase {
  id: string
  type: 'parser-test-case'
  attributes: {
    name: string
    mail_sample_id: string
    expected: Record<string, unknown>
    enabled: boolean
    mail_message: {
      id: string
      subject: string | null
      from_address: string | null
    }
    created_at: string
    updated_at: string
  }
}

export interface ParserFlowDetail {
  id: string
  type: 'parser-flow'
  attributes: ParserFlowSummary['attributes'] & {
    draft_definition: ParserFlowDefinition
    draft_source_yaml: string
    created_at: string
    test_cases: ParserTestCase[]
  }
}

export interface SourceLocator {
  artifact_id?: string | null
  sheet?: string | null
  page?: number | null
  row?: number | null
  dom_path?: string | null
}

export interface ParserDiagnostic {
  severity: 'warning' | 'error'
  code: string
  message: string
  node_id?: string | null
  locator?: SourceLocator | null
}

export interface BillRowDraft {
  occurred_at: string
  posted_at?: string | null
  signed_amount: string
  currency_code: string
  foreign_amount?: string | null
  foreign_currency_code?: string | null
  balance_after?: string | null
  description: string
  counterparty?: string | null
  counterparty_account?: string | null
  account_hint?: string | null
  payment_method?: string | null
  provider_transaction_id?: string | null
  merchant_order_id?: string | null
  provider_category?: string | null
  provider_status?: string | null
  remark?: string | null
  source_locator: SourceLocator
  raw_fields: Record<string, string>
  warnings: ParserDiagnostic[]
  issues: ParserDiagnostic[]
}

export interface InvalidBillRow {
  locator: SourceLocator
  raw_fields: Record<string, string>
  issues: ParserDiagnostic[]
}

export interface ParserNodeResult {
  node_id: string
  node_type: string
  duration_ms: number
  input_count: number
  output_count: number
  diagnostics: ParserDiagnostic[]
  preview: unknown
}

export interface ParseOutput {
  document: Record<string, unknown>
  valid_rows: BillRowDraft[]
  invalid_rows: InvalidBillRow[]
  warnings: ParserDiagnostic[]
  metrics: {
    duration_ms: number
    input_artifacts: number
    records: number
    valid_rows: number
    invalid_rows: number
  }
  node_results: ParserNodeResult[]
}

export interface ParserVersion {
  version: number
  checksum: string
  created_by: string
  created_at: string
}

export interface ParserVersionDetail extends ParserVersion {
  flow_id: string
  definition: ParserFlowDefinition
  source_yaml: string
  compared_to_version: number | null
  diff_from_previous: ParserDefinitionChange[]
  diff_truncated: boolean
}

export interface ParserDefinitionChange {
  path: string
  kind: 'added' | 'removed' | 'changed'
  before: unknown
  after: unknown
}

export interface ParserBreakingChange {
  case_id: string
  case_name: string
  code: 'valid_rows_decreased' | 'amount_total_changed' | 'field_became_empty'
  before: unknown
  after: unknown
  currency_code?: string
  row?: string
  field?: string
}

interface Collection<T> { data: T[] }
interface Item<T> { data: T }

export function validateParserFlow(sourceYaml: string): Promise<{
  data: {
    valid: true
    checksum: string
    definition: ParserFlowDefinition
    normalized_yaml: string
  }
}> {
  return apiPost('/v1/parser-flows/validate', { source_yaml: sourceYaml })
}

export function getParserFlows(): Promise<Collection<ParserFlowSummary>> {
  return apiGet('/v1/parser-flows')
}

export function getParserFlow(id: string): Promise<Item<ParserFlowDetail>> {
  return apiGet(`/v1/parser-flows/${id}`)
}

export function createParserFlow(input: {
  name: string
  slug: string
  source_yaml: string
}): Promise<Item<ParserFlowDetail>> {
  return apiPost('/v1/parser-flows', input)
}

export function updateParserFlow(id: string, input: {
  name?: string
  source_yaml?: string
}): Promise<Item<ParserFlowDetail>> {
  return apiPatch(`/v1/parser-flows/${id}`, input)
}

export function cloneParserFlow(id: string, input: {
  name: string
  slug: string
}): Promise<Item<ParserFlowDetail>> {
  return apiPost(`/v1/parser-flows/${id}/clone`, input)
}

export function testParserFlow(id: string, input: {
  mail_message_id?: number
  mail_sample_id?: number
  source_yaml?: string
  version?: number
  timezone?: string
  secrets?: Record<string, string>
}): Promise<Item<{
  run_id: string
  status: 'succeeded'
  output: ParseOutput
}>> {
  return apiPost(`/v1/parser-flows/${id}/test`, input)
}

export function testParserEml(id: string, input: {
  eml: File
  source_yaml?: string
  version?: number
  timezone?: string
  secrets?: Record<string, string>
}): Promise<Item<{
  run_id: string
  status: 'succeeded'
  output: ParseOutput
}>> {
  const body = new FormData()
  body.append('eml', input.eml, input.eml.name)
  if (input.source_yaml !== undefined) body.append('source_yaml', input.source_yaml)
  if (input.version !== undefined) body.append('version', String(input.version))
  if (input.timezone) body.append('timezone', input.timezone)
  if (input.secrets) body.append('secrets', JSON.stringify(input.secrets))
  return apiPostForm(`/v1/parser-flows/${id}/test-eml`, body)
}

export function previewParserPublish(id: string): Promise<{
  dry_run: true
  data: {
    flow_id: string
    checksum: string
    test_cases: Array<Record<string, unknown>>
    comparison: {
      baseline_version: number | null
      breaking: boolean
      changes: ParserBreakingChange[]
    }
    ready: true
  }
}> {
  return apiPost(`/v1/parser-flows/${id}/publish`, {}, { dry_run: true })
}

export function publishParserFlow(id: string): Promise<Item<ParserFlowDetail>> {
  return apiPost(`/v1/parser-flows/${id}/publish`, {}, { confirm: true })
}

export function retireParserFlow(id: string): Promise<Item<ParserFlowDetail>> {
  return apiPost(`/v1/parser-flows/${id}/retire`, {}, { confirm: true })
}

export function rollbackParserFlow(id: string, targetVersion: number): Promise<Item<ParserFlowDetail>> {
  return apiPost(`/v1/parser-flows/${id}/rollback`, { target_version: targetVersion }, { confirm: true })
}

export function getParserVersions(id: string): Promise<Collection<ParserVersion>> {
  return apiGet(`/v1/parser-flows/${id}/versions`)
}

export function getParserVersion(id: string, version: number): Promise<Item<ParserVersionDetail>> {
  return apiGet(`/v1/parser-flows/${id}/versions/${version}`)
}

export function createParserTestCase(flowId: string, input: {
  name: string
  mail_sample_id: number
  expected: Record<string, unknown>
  enabled: boolean
}): Promise<Item<ParserTestCase>> {
  return apiPost(`/v1/parser-flows/${flowId}/test-cases`, input)
}

export function updateParserTestCase(id: string, input: {
  name: string
  mail_sample_id: number
  expected: Record<string, unknown>
  enabled: boolean
}): Promise<Item<ParserTestCase>> {
  return apiPatch(`/v1/parser-test-cases/${id}`, input)
}

export function deleteParserTestCase(id: string): Promise<void> {
  return apiDeleteJson(`/v1/parser-test-cases/${id}`, {}, { confirm: true })
}
