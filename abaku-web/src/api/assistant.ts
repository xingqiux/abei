import { getActiveToken, UNAUTHORIZED_EVENT } from "./client";

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
  capability: string;
  input: Record<string, unknown>;
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
      input: Record<string, unknown>;
    }
  | {
      type: "tool_end";
      tool_call_id: string;
      capability: string;
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
