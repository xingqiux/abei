import { getActiveToken, UNAUTHORIZED_EVENT } from "./client";
import {
  backfillSuggestionsResponseSchema,
  categoryRuleItemResponseSchema,
  categoryRulesResponseSchema,
  vocabSuggestionsResponseSchema,
  type BackfillSuggestion,
  type CategoryRule,
  type VocabSuggestion,
} from "./schemas";

export interface AssistantHealth {
  status: string;
  configured: boolean;
  source: "saved" | "environment";
  provider: string;
  model: string;
  apiUrl?: string;
  accountId?: string;
  gatewayId?: string;
  error?: string;
}

export type AssistantModelProvider =
  | "openai"
  | "anthropic"
  | "google"
  | "cloudflare-ai-gateway"
  | "cloudflare-workers-ai"
  | "ollama";

export interface AssistantModelConfigInput {
  provider: AssistantModelProvider;
  model: string;
  apiToken?: string;
  apiUrl?: string;
  accountId?: string;
  gatewayId?: string;
}

export type AssistantModelDiscoveryInput = Omit<
  AssistantModelConfigInput,
  "model"
>;

export interface AssistantSession {
  id: string;
  title: string;
  provider: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  pendingApprovals: number;
}

export interface AssistantMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp?: number;
}

export interface AssistantApproval {
  id: string;
  sessionId: string;
  /** 能力 id，例如 bills.unlock。 */
  capability: string;
  /**
   * 目录里的中文标签，agent 已经替页面取好了。
   * 它和 `/v1/catalog` 同源，不是第二份手写表；老会话的历史记录里可能没有，
   * 那时页面回落到现拉目录。
   */
  label?: string;
  risk?: "read" | "draft" | "confirm";
  /**
   * 还缺人当场填的参数名（目前只有 `secret`）。空数组表示只要点一下确认。
   * 页面据此决定弹不弹输入框，不再按能力名写死分支。
   */
  needs_user_input?: string[];
  input: Record<string, unknown>;
  /**
   * 干跑预览。要人填参数的能力做不了干跑（abei-api 在闸门之后才校验那些字段），
   * 这时预览是空的——那是正常状态，不是失败。
   */
  preview: unknown;
  status: "pending" | "executing" | "approved" | "rejected";
  result: unknown;
  createdAt: string;
  decidedAt?: string;
}

export interface AssistantHistory {
  session: AssistantSession;
  messages: AssistantMessage[];
  approvals: AssistantApproval[];
}

export type AssistantStreamEvent =
  | { type: "meta"; session_id: string; provider: string; model: string }
  | { type: "text_delta"; delta: string }
  | {
      type: "tool_start";
      tool_call_id: string;
      capability: string;
      /** 目录里的标签，agent 已取好；老服务端可能不带。 */
      label?: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_end";
      tool_call_id: string;
      capability: string;
      label?: string;
      error: boolean;
    }
  | { type: "approval"; approval: AssistantApproval }
  | { type: "done"; session_id: string }
  | { type: "error"; message: string };

export class AssistantApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "AssistantApiError";
  }
}

export function getAssistantHealth(
  signal?: AbortSignal,
): Promise<AssistantHealth> {
  return assistantJson("/api/ai/config", { signal });
}

/**
 * AI 自动预填（设计稿 03）。总开关存在 abei-agent 侧，
 * 打开时要把当前 Firefly PAT 交给它，worker 才能替用户回写建议。
 */
export interface AutofillConfig {
  enabled: boolean;
  interval_seconds: number;
  /**
   * 后端是否已经存着一份能用的 Firefly 令牌。worker 在后台替人回写建议，
   * 没有令牌它谁也不是——所以 has_token=false 时开启必须顺带把当前 PAT 送过去。
   */
  has_token: boolean;
}

export interface AutofillConfigInput {
  enabled: boolean;
  interval_seconds?: number;
  token?: string;
}

export interface AutofillRunResult {
  tasks: number;
  rows: number;
  failed?: number;
}

export function getAutofillConfig(
  signal?: AbortSignal,
): Promise<AutofillConfig> {
  return assistantJson("/api/ai/autofill-config", { signal });
}

export function saveAutofillConfig(
  input: AutofillConfigInput,
): Promise<AutofillConfig> {
  return assistantJson("/api/ai/autofill-config", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * 手动补跑：收件箱里有 AI 还没碰过的行时给一个「让 AI 出建议」按钮。
 * 409 表示后台已经在跑了——那不是错误，调用方按「已经在跑」提示。
 */
export function runAutofill(taskIds?: string[]): Promise<AutofillRunResult> {
  return assistantJson("/api/ai/autofill/run", {
    method: "POST",
    body: JSON.stringify(taskIds?.length ? { task_ids: taskIds } : {}),
  });
}

/* ------------------------------------------------------------------ *
 * 分类引擎：规则、纠正反馈、未分类回填、词表建议
 * 都住在 abei-agent 侧，和 autofill 同源同鉴权。
 * ------------------------------------------------------------------ */

/** GET /api/ai/category-rules —— 「已学会的规则」列表 */
export async function getCategoryRules(
  signal?: AbortSignal,
): Promise<CategoryRule[]> {
  const raw = await assistantJson<unknown>("/api/ai/category-rules", { signal });
  return categoryRulesResponseSchema.parse(raw).data;
}

/** PATCH /api/ai/category-rules/:id —— 只切停用开关，不删数据 */
export async function updateCategoryRule(
  id: string,
  enabled: boolean,
): Promise<CategoryRule> {
  const raw = await assistantJson<unknown>(
    `/api/ai/category-rules/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify({ enabled }) },
  );
  return categoryRuleItemResponseSchema.parse(raw).data;
}

/** DELETE /api/ai/category-rules/:id */
export function deleteCategoryRule(id: string): Promise<void> {
  return assistantVoid(`/api/ai/category-rules/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/**
 * POST /api/ai/category-feedback —— 纠正即学习。
 * make_rule=true 生成一条规则；false 只当反馈样本记着（同一模式改够次数才会提示立规则）。
 */
export interface CategoryFeedbackInput {
  pattern: string;
  category_name: string;
  make_rule: boolean;
}

export function postCategoryFeedback(
  payload: CategoryFeedbackInput,
): Promise<void> {
  return assistantVoid("/api/ai/category-feedback", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/**
 * POST /api/ai/backfill/run —— 给未分类交易出建议。
 * 和 autofill 一样用 409 防并发：409 不是错误，调用方按「已经在跑」提示。
 */
export interface BackfillRunResult {
  transactions?: number;
  suggestions?: number;
}

export function runBackfill(): Promise<BackfillRunResult> {
  return assistantJson("/api/ai/backfill/run", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

/** GET /api/ai/backfill/suggestions —— 待人确认的建议，引擎不直接改分类 */
export async function getBackfillSuggestions(
  signal?: AbortSignal,
): Promise<BackfillSuggestion[]> {
  const raw = await assistantJson<unknown>("/api/ai/backfill/suggestions", {
    signal,
  });
  return backfillSuggestionsResponseSchema.parse(raw).data;
}

/** POST /api/ai/backfill/suggestions/:journalId/resolve —— applied=true 表示人采纳了 */
export function resolveBackfillSuggestion(
  journalId: string,
  applied: boolean,
): Promise<void> {
  return assistantVoid(
    `/api/ai/backfill/suggestions/${encodeURIComponent(journalId)}/resolve`,
    { method: "POST", body: JSON.stringify({ applied }) },
  );
}

/** GET /api/ai/vocab-suggestions —— AI 想动词表时只能到这里说，改不改由人定 */
export async function getVocabSuggestions(
  signal?: AbortSignal,
): Promise<VocabSuggestion[]> {
  const raw = await assistantJson<unknown>("/api/ai/vocab-suggestions", {
    signal,
  });
  return vocabSuggestionsResponseSchema.parse(raw).data;
}

/**
 * POST /api/ai/vocab-suggestions/:id —— 回报处置结果。
 * accept 只是记账：词表由前端先落好再回报，后端不代改。ignore 后同一建议 30 天不再出。
 */
export function actVocabSuggestion(
  id: string,
  action: "accept" | "ignore",
): Promise<void> {
  return assistantVoid(`/api/ai/vocab-suggestions/${encodeURIComponent(id)}`, {
    method: "POST",
    body: JSON.stringify({ action }),
  });
}

export function saveAssistantModelConfig(
  input: AssistantModelConfigInput,
): Promise<AssistantHealth> {
  return assistantJson("/api/ai/config", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function deleteAssistantModelConfig(): Promise<AssistantHealth> {
  return assistantJson("/api/ai/config", { method: "DELETE" });
}

export async function listAssistantModels(
  input: AssistantModelDiscoveryInput,
  signal?: AbortSignal,
): Promise<string[]> {
  const response = await assistantJson<{ data: string[] }>("/api/ai/models", {
    method: "POST",
    signal,
    body: JSON.stringify(input),
  });
  return response.data;
}

export async function listAssistantSessions(
  signal?: AbortSignal,
): Promise<AssistantSession[]> {
  const response = await assistantJson<{ data: AssistantSession[] }>(
    "/api/ai/sessions",
    { signal },
  );
  return response.data;
}

export async function getAssistantHistory(
  id: string,
  signal?: AbortSignal,
): Promise<AssistantHistory> {
  const response = await assistantJson<{ data: AssistantHistory }>(
    `/api/ai/sessions/${encodeURIComponent(id)}`,
    { signal },
  );
  return response.data;
}

export async function decideAssistantApproval(
  id: string,
  decision: "approve" | "reject",
  userInput?: Record<string, unknown>,
): Promise<AssistantApproval> {
  const response = await assistantJson<{ data: AssistantApproval }>(
    `/api/ai/approvals/${encodeURIComponent(id)}`,
    {
      method: "POST",
      body: JSON.stringify({ decision, user_input: userInput }),
    },
  );
  return response.data;
}

export async function streamAssistantMessage(args: {
  message: string;
  sessionId?: string;
  signal?: AbortSignal;
  onEvent: (event: AssistantStreamEvent) => void;
}): Promise<void> {
  const token = getActiveToken();
  const response = await fetch("/api/ai/chat", {
    method: "POST",
    signal: args.signal,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/x-ndjson",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message: args.message, session_id: args.sessionId }),
  });
  if (!response.ok) throw await responseError(response);
  if (!response.body)
    throw new AssistantApiError(502, "AI 服务没有返回流式响应");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (getActiveToken() !== token) {
      await reader.cancel();
      throw new AssistantApiError(409, "认证身份已变更，已停止旧会话");
    }
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) emitLine(line, args.onEvent);
  }
  pending += decoder.decode();
  if (pending.trim()) emitLine(pending, args.onEvent);
}

async function assistantJson<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = getActiveToken();
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });
  if (!response.ok) throw await responseError(response);
  return response.json() as Promise<T>;
}

/**
 * 不关心响应体的写操作。DELETE 常回 204，硬 .json() 会抛「Unexpected end of JSON input」，
 * 那个报错和真正的失败长得一样，排查起来很浪费时间。
 */
async function assistantVoid(
  path: string,
  init: RequestInit = {},
): Promise<void> {
  const token = getActiveToken();
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });
  if (!response.ok) throw await responseError(response);
}

async function responseError(response: Response): Promise<AssistantApiError> {
  let message = `${response.status} ${response.statusText}`;
  try {
    const body = (await response.json()) as { error?: string };
    if (body.error) message = body.error;
  } catch {
    // 非 JSON 错误沿用 HTTP 状态。
  }
  if (response.status === 401)
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
  return new AssistantApiError(response.status, message);
}

function emitLine(
  line: string,
  onEvent: (event: AssistantStreamEvent) => void,
): void {
  if (!line.trim()) return;
  try {
    onEvent(JSON.parse(line) as AssistantStreamEvent);
  } catch {
    throw new AssistantApiError(502, "AI 服务返回了无法解析的数据");
  }
}
