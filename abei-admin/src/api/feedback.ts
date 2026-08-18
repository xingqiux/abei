import { z } from 'zod'
import { apiGet, apiPatch, apiPost, type QueryParams } from './client'
import {
  zAdminFeedbackItemsArchiveBody,
  zAdminFeedbackItemsMergeBody,
  zAdminFeedbackItemsPublishUpdateBody,
  zAdminFeedbackItemsRestoreBody,
  zAdminFeedbackItemsUpdateBody,
  zAdminFeedbackSubmissionsLinkBody,
  zAdminFeedbackSubmissionsMessageBody,
  zAdminFeedbackSubmissionsUpdateBody,
  zFeedbackConfirmBody,
  zFeedbackCreateBody,
  zFeedbackReplyBody,
} from './generated/zod.gen'

export type FeedbackKind = 'bug' | 'experience' | 'suggestion'
export type FeedbackTarget = 'cli' | 'app' | 'web'
export type FeedbackStatus = 'open' | 'reviewing' | 'planned' | 'in_progress' | 'completed' | 'closed'
export type FeedbackSeverity = 'critical' | 'high' | 'normal' | 'low'
export type FeedbackSubmissionState =
  | 'needs_confirmation'
  | 'pending_confirmation'
  | 'linked'
  | 'needs_information'
  | 'dismissed'
  | 'redacted'

const candidateSchema = z.object({
  feedback_id: z.number().int().positive(),
  title: z.string(),
  kind: z.string(),
  target: z.string(),
  status: z.string(),
  affected_users: z.number().int().nonnegative(),
  occurrences: z.number().int().nonnegative(),
  match: z.object({
    reason: z.string(),
    confidence: z.string(),
    score: z.number(),
    algorithm_version: z.number().int(),
  }),
})

const itemSchema = z.object({
  feedback_id: z.number().int().positive(),
  title: z.string(),
  kind: z.enum(['bug', 'experience', 'suggestion']),
  target: z.enum(['cli', 'app', 'web']),
  status: z.enum(['open', 'reviewing', 'planned', 'in_progress', 'completed', 'closed']),
  severity: z.enum(['critical', 'high', 'normal', 'low']).nullable(),
  public_summary: z.string(),
  close_reason: z.string().nullable().optional(),
  merged_into_id: z.number().int().positive().nullable().optional(),
  affected_users: z.number().int().nonnegative(),
  occurrences: z.number().int().nonnegative(),
  first_seen: z.string().nullable(),
  last_seen: z.string().nullable(),
  my_submission_ids: z.array(z.number().int().positive()).optional(),
  archived_at: z.string().nullable(),
  archived_by: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  completed_at: z.string().nullable().optional(),
})

const messageSchema = z.object({
  id: z.number().int().positive(),
  submission_id: z.number().int().positive(),
  author_kind: z.enum(['user', 'admin', 'system']),
  body: z.string(),
  created_at: z.string(),
})

const pendingSubmissionSchema = z.object({
  submission_id: z.number().int().positive(),
  kind: z.enum(['bug', 'experience', 'suggestion']),
  target: z.enum(['cli', 'app', 'web']),
  submitted_via: z.string(),
  message: z.string(),
  expected: z.string().nullable(),
  actual: z.string().nullable(),
  state: z.enum(['needs_confirmation', 'needs_information']),
  candidates: z.array(candidateSchema),
  messages: z.array(messageSchema).default([]),
  created_at: z.string(),
  last_seen_at: z.string(),
})

const paginationSchema = z.object({
  limit: z.number().int(),
  offset: z.number().int(),
  /** 本页返回了多少条，不是总数。 */
  count: z.number().int(),
  /**
   * 总数。服务端目前不发，所以是可选的——前端拿不到时只能说「100+」，不能拿 count 冒充总数。
   * 服务端补上之后这里不用改。
   */
  total: z.number().int().optional(),
})

const feedbackListSchema = z.object({
  data: z.array(itemSchema),
  pending: z.array(pendingSubmissionSchema),
  pagination: paginationSchema,
})

const submissionResultSchema = z.object({
  submission_id: z.number().int().positive(),
  feedback_id: z.number().int().positive().nullable().optional(),
  state: z.string(),
  status: z.string().nullable().optional(),
  affected_users: z.number().int().nonnegative().optional(),
  occurrences: z.number().int().nonnegative().optional(),
  candidates: z.array(candidateSchema).optional(),
  next_actions: z.array(z.string()).optional(),
})

const feedbackUpdateSchema = z.object({
  id: z.number().int().positive(),
  item_id: z.number().int().positive().optional(),
  body: z.string(),
  status: z.string(),
  created_at: z.string(),
})

const submissionSchema = z.object({
  submission_id: z.number().int().positive(),
  kind: z.enum(['bug', 'experience', 'suggestion']),
  target: z.enum(['cli', 'app', 'web']),
  submitted_via: z.string(),
  message: z.string(),
  expected: z.string().nullable(),
  actual: z.string().nullable(),
  state: z.string(),
  context: z.unknown().optional(),
  match_candidates: z.unknown().optional(),
  created_at: z.string(),
  linked_at: z.string().nullable(),
  last_seen_at: z.string(),
})

const auditSchema = z.object({
  id: z.number().int().positive(),
  item_id: z.number().int().positive().nullable(),
  submission_id: z.number().int().positive().nullable(),
  event_type: z.string(),
  actor_kind: z.string(),
  actor_user_id: z.number().int().positive().nullable(),
  metadata: z.unknown(),
  created_at: z.string(),
})

const detailSchema = z.object({
  data: itemSchema,
  updates: z.array(feedbackUpdateSchema),
  submissions: z.array(submissionSchema),
  messages: z.array(messageSchema),
  audit: z.array(auditSchema),
  permissions: z.object({ manage: z.boolean() }),
})

const adminSubmissionSchema = z.object({
  submission_id: z.number().int().positive(),
  feedback_id: z.number().int().positive().nullable(),
  user_id: z.number().int().positive().nullable(),
  kind: z.enum(['bug', 'experience', 'suggestion']),
  target: z.enum(['cli', 'app', 'web']),
  submitted_via: z.string(),
  message: z.string(),
  expected: z.string().nullable(),
  actual: z.string().nullable(),
  state: z.string(),
  context: z.unknown(),
  fingerprint_version: z.number().int(),
  has_fingerprint: z.boolean(),
  match_algorithm_version: z.number().int(),
  candidates: z.array(candidateSchema),
  item_title: z.string().nullable(),
  item_status: z.string().nullable(),
  message_count: z.number().int().nonnegative(),
  created_at: z.string(),
  linked_at: z.string().nullable(),
  last_seen_at: z.string(),
})

const adminSubmissionListSchema = z.object({
  data: z.array(adminSubmissionSchema),
  pagination: paginationSchema,
})

const adminSubmissionDetailSchema = z.object({
  data: adminSubmissionSchema,
  messages: z.array(messageSchema),
  audit: z.array(auditSchema),
})

const adminItemListSchema = z.object({
  data: z.array(itemSchema),
  pagination: paginationSchema,
})

const messageResponseSchema = z.object({ data: messageSchema })
const updateResponseSchema = z.object({ data: feedbackUpdateSchema })
const sessionSchema = z.object({
  data: z.object({
    user_id: z.number().int().positive(),
    actor: z.string(),
    role: z.string(),
    is_owner: z.boolean(),
  }),
})

export type FeedbackCandidate = z.infer<typeof candidateSchema>
export type FeedbackItem = z.infer<typeof itemSchema>
export type PendingFeedbackSubmission = z.infer<typeof pendingSubmissionSchema>
export type FeedbackListResponse = z.infer<typeof feedbackListSchema>
export type FeedbackSubmissionResult = z.infer<typeof submissionResultSchema>
export type FeedbackUpdate = z.infer<typeof feedbackUpdateSchema>
export type FeedbackSubmission = z.infer<typeof submissionSchema>
export type FeedbackMessage = z.infer<typeof messageSchema>
export type FeedbackDetailResponse = z.infer<typeof detailSchema>
export type AdminFeedbackSubmission = z.infer<typeof adminSubmissionSchema>
export type AdminFeedbackSubmissionDetail = z.infer<typeof adminSubmissionDetailSchema>
export type SessionResponse = z.infer<typeof sessionSchema>

export function feedbackIdempotencyKey(): string {
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `web:${random}`
}

export function getSession(): Promise<SessionResponse> {
  return apiGet('/v1/session').then((value) => sessionSchema.parse(value))
}

export function listFeedback(params: {
  kind?: FeedbackKind
  target?: FeedbackTarget
  status?: FeedbackStatus
  limit?: number
  offset?: number
} = {}): Promise<FeedbackListResponse> {
  return apiGet('/v1/feedback', params).then((value) => feedbackListSchema.parse(value))
}

export function createFeedback(
  input: {
    kind: FeedbackKind
    target: FeedbackTarget
    message: string
    expected?: string
    actual?: string
  },
  idempotencyKey: string,
): Promise<FeedbackSubmissionResult> {
  const body = zFeedbackCreateBody.parse({
    ...input,
    expected: input.expected || undefined,
    actual: input.actual || undefined,
    submitted_via: 'web',
    idempotency_key: idempotencyKey,
    context: { recorded_at: new Date().toISOString() },
  })
  return apiPost('/v1/feedback', body).then((value) => submissionResultSchema.parse(value))
}

export function confirmFeedback(
  submissionId: number,
  decision: { same_as: number } | { new: true },
): Promise<FeedbackSubmissionResult> {
  const parsed = zFeedbackConfirmBody.parse(decision)
  const body = parsed.same_as == null
    ? { new: true as const }
    : { same_as: Number(parsed.same_as) }
  return apiPost(`/v1/feedback/submissions/${submissionId}/confirm`, body)
    .then((value) => submissionResultSchema.parse(value))
}

export function replyFeedback(submissionId: number, message: string): Promise<FeedbackMessage> {
  const body = zFeedbackReplyBody.parse({ message })
  return apiPost(`/v1/feedback/submissions/${submissionId}/messages`, body)
    .then((value) => messageResponseSchema.parse(value).data)
}

export function getFeedback(feedbackId: number): Promise<FeedbackDetailResponse> {
  return apiGet(`/v1/feedback/${feedbackId}`).then((value) => detailSchema.parse(value))
}

export function listAdminFeedbackSubmissions(params: {
  state?: string
  kind?: FeedbackKind
  target?: FeedbackTarget
  item_id?: number
  limit?: number
  offset?: number
} = {}) {
  return apiGet('/v1/admin/feedback/submissions', params)
    .then((value) => adminSubmissionListSchema.parse(value))
}

export function getAdminFeedbackSubmission(submissionId: number) {
  return apiGet(`/v1/admin/feedback/submissions/${submissionId}`)
    .then((value) => adminSubmissionDetailSchema.parse(value))
}

export function moderateAdminFeedbackSubmission(
  submissionId: number,
  input: { state: 'dismissed' | 'redacted'; reason: string },
) {
  const body = zAdminFeedbackSubmissionsUpdateBody.parse(input)
  return apiPatch(`/v1/admin/feedback/submissions/${submissionId}`, body)
    .then((value) => adminSubmissionDetailSchema.parse(value))
}

export function linkAdminFeedbackSubmission(
  submissionId: number,
  input: { item_id?: number; new?: boolean; title?: string; reason: string },
) {
  const body = zAdminFeedbackSubmissionsLinkBody.parse(input)
  return apiPost(`/v1/admin/feedback/submissions/${submissionId}/link`, body)
    .then((value) => adminSubmissionDetailSchema.parse(value))
}

export function messageAdminFeedbackSubmission(submissionId: number, message: string) {
  const body = zAdminFeedbackSubmissionsMessageBody.parse({ message })
  return apiPost(`/v1/admin/feedback/submissions/${submissionId}/messages`, body)
    .then((value) => messageResponseSchema.parse(value).data)
}

export function listAdminFeedbackItems(params: {
  archived?: boolean
  kind?: FeedbackKind
  target?: FeedbackTarget
  status?: FeedbackStatus
  severity?: FeedbackSeverity
  limit?: number
  offset?: number
} = {}) {
  return apiGet('/v1/admin/feedback/items', params as QueryParams)
    .then((value) => adminItemListSchema.parse(value))
}

export function getAdminFeedbackItem(feedbackId: number) {
  return apiGet(`/v1/admin/feedback/items/${feedbackId}`).then((value) => detailSchema.parse(value))
}

export function updateAdminFeedbackItem(
  feedbackId: number,
  input: {
    title?: string
    kind?: FeedbackKind
    target?: FeedbackTarget
    status?: FeedbackStatus
    severity?: FeedbackSeverity | null
    public_summary?: string
    close_reason?: string | null
    update?: string | null
  },
) {
  const body = zAdminFeedbackItemsUpdateBody.parse(input)
  return apiPatch(`/v1/admin/feedback/items/${feedbackId}`, body)
    .then((value) => detailSchema.parse(value))
}

export function publishAdminFeedbackUpdate(feedbackId: number, bodyText: string) {
  const body = zAdminFeedbackItemsPublishUpdateBody.parse({ body: bodyText })
  return apiPost(`/v1/admin/feedback/items/${feedbackId}/updates`, body)
    .then((value) => updateResponseSchema.parse(value).data)
}

export function mergeAdminFeedbackItem(feedbackId: number, targetId: number, reason: string) {
  const body = zAdminFeedbackItemsMergeBody.parse({ target_id: targetId, reason })
  return apiPost(`/v1/admin/feedback/items/${feedbackId}/merge`, body)
    .then((value) => detailSchema.parse(value))
}

export function archiveAdminFeedbackItem(feedbackId: number, reason: string) {
  const body = zAdminFeedbackItemsArchiveBody.parse({ reason })
  return apiPost(`/v1/admin/feedback/items/${feedbackId}/archive`, body)
    .then((value) => detailSchema.parse(value))
}

export function restoreAdminFeedbackItem(feedbackId: number, reason: string) {
  const body = zAdminFeedbackItemsRestoreBody.parse({ reason })
  return apiPost(`/v1/admin/feedback/items/${feedbackId}/restore`, body)
    .then((value) => detailSchema.parse(value))
}
