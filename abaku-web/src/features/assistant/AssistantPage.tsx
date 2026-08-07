import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  CheckIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  LockClosedIcon,
  PaperAirplaneIcon,
  PlusIcon,
  SparklesIcon,
  WrenchScrewdriverIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import {
  decideAssistantApproval,
  getAssistantHealth,
  getAssistantHistory,
  listAssistantSessions,
  streamAssistantMessage,
  type AssistantApproval,
  type AssistantMessage,
} from "../../api/assistant";
import { Button, IconButton } from "../../components/ui/Button";
import { CONTROL_COMPACT, Input, Textarea } from "../../components/ui/Field";
import { showToast } from "../../store/toastStore";

const CAPABILITY_LABELS: Record<string, string> = {
  list_bill_tasks: "查看账单任务",
  review_bill_task: "审阅账单",
  update_bill_row: "填写账单建议",
  split_bill_row: "拆分组合支付",
  import_bill_task: "导入账单",
  submit_bill_secret: "提交账单密码",
  search_transactions: "搜索历史交易",
  spending_summary: "汇总消费",
};

const STARTERS = [
  "这个月花了多少？",
  "看看有哪些账单还没处理",
  "帮我审阅最新一份账单",
];

interface ToolActivity {
  id: string;
  capability: string;
  state: "running" | "done" | "error";
}

export function AssistantPage() {
  const search = useSearch({ from: "/assistant" });
  const navigate = useNavigate({ from: "/assistant" });
  const queryClient = useQueryClient();
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [approvals, setApprovals] = useState<AssistantApproval[]>([]);
  const [activities, setActivities] = useState<ToolActivity[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const healthQuery = useQuery({
    queryKey: ["assistant-health"],
    queryFn: ({ signal }) => getAssistantHealth(signal),
  });
  const configured = healthQuery.data?.configured === true;
  const sessionsQuery = useQuery({
    queryKey: ["assistant-sessions"],
    queryFn: ({ signal }) => listAssistantSessions(signal),
    enabled: configured,
  });
  const historyQuery = useQuery({
    queryKey: ["assistant-history", search.session],
    queryFn: ({ signal }) => getAssistantHistory(search.session!, signal),
    enabled: configured && Boolean(search.session),
  });

  useEffect(() => {
    if (!search.session) {
      setMessages([]);
      setApprovals([]);
      setActivities([]);
      return;
    }
    if (historyQuery.data) {
      setMessages(historyQuery.data.messages);
      setApprovals(historyQuery.data.approvals);
      setActivities([]);
    }
  }, [search.session, historyQuery.data]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, approvals, activities]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const activeSession = useMemo(
    () => sessionsQuery.data?.find((session) => session.id === search.session),
    [search.session, sessionsQuery.data],
  );
  function openSession(session?: string) {
    if (streaming) return;
    void navigate({ search: { session }, replace: true });
  }

  async function send(text = draft) {
    const prompt = text.trim();
    if (!prompt || streaming || !configured) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setDraft("");
    setStreaming(true);
    setStreamError(null);
    setActivities([]);
    setMessages((current) => [
      ...current,
      {
        id: `user-${Date.now()}`,
        role: "user",
        content: prompt,
        timestamp: Date.now(),
      },
      {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: "",
        timestamp: Date.now(),
      },
    ]);
    let nextSessionId = search.session;
    let eventError: string | null = null;

    try {
      await streamAssistantMessage({
        message: prompt,
        sessionId: search.session,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "meta") {
            nextSessionId = event.session_id;
          } else if (event.type === "text_delta") {
            setMessages((current) =>
              appendAssistantDelta(current, event.delta),
            );
          } else if (event.type === "tool_start") {
            setActivities((current) => [
              ...current,
              {
                id: event.tool_call_id,
                capability: event.capability,
                state: "running",
              },
            ]);
          } else if (event.type === "tool_end") {
            setActivities((current) =>
              current.map((item) =>
                item.id === event.tool_call_id
                  ? { ...item, state: event.error ? "error" : "done" }
                  : item,
              ),
            );
          } else if (event.type === "approval") {
            setApprovals((current) => [...current, event.approval]);
          } else if (event.type === "error") {
            eventError = event.message;
            setStreamError(event.message);
          }
        },
      });
      if (eventError) setMessages((current) => removeEmptyAssistant(current));
      if (nextSessionId && nextSessionId !== search.session) {
        await navigate({ search: { session: nextSessionId }, replace: true });
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["assistant-sessions"] }),
        nextSessionId
          ? queryClient.invalidateQueries({
              queryKey: ["assistant-history", nextSessionId],
            })
          : Promise.resolve(),
      ]);
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = error instanceof Error ? error.message : "AI 请求失败";
        setStreamError(message);
        setMessages((current) => removeEmptyAssistant(current));
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setStreaming(false);
    }
  }

  async function decide(
    approval: AssistantApproval,
    decision: "approve" | "reject",
    secret?: string,
  ) {
    try {
      setApprovals((current) =>
        current.map((item) =>
          item.id === approval.id ? { ...item, status: "executing" } : item,
        ),
      );
      const updated = await decideAssistantApproval(
        approval.id,
        decision,
        secret === undefined ? undefined : { secret },
      );
      setApprovals((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      void queryClient.invalidateQueries({ queryKey: ["assistant-sessions"] });
      showToast({
        kind: decision === "approve" ? "success" : "inbox",
        message: decision === "approve" ? "操作已确认执行" : "操作已拒绝",
      });
    } catch (error) {
      setApprovals((current) =>
        current.map((item) =>
          item.id === approval.id ? { ...item, status: "pending" } : item,
        ),
      );
      showToast({
        kind: "error",
        message: error instanceof Error ? error.message : "审批失败",
      });
    }
  }

  return (
    <div className="flex min-h-[calc(100dvh-10rem)] flex-col overflow-hidden rounded-lg bg-[var(--surface-1)] shadow-[var(--shadow-card)] ring-1 ring-[var(--ring-card)] md:h-[calc(100dvh-7rem)] md:min-h-[560px]">
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <SparklesIcon
              aria-hidden
              className="size-4 text-[var(--brand-text)]"
            />
            <h1 className="truncate text-sm font-semibold text-[var(--text-primary)]">
              财务助手
            </h1>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-[var(--text-tertiary)]">
            {healthQuery.isLoading
              ? "正在连接模型"
              : configured
                ? `${healthQuery.data?.provider} · ${healthQuery.data?.model}`
                : healthQuery.isError
                  ? "连接中断"
                  : "尚未启用"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            aria-label="切换对话"
            value={search.session ?? ""}
            disabled={streaming}
            onChange={(event) => openSession(event.target.value || undefined)}
            className={`${CONTROL_COMPACT} max-w-44 md:hidden`}
          >
            <option value="">新对话</option>
            {(sessionsQuery.data ?? []).map((session) => (
              <option key={session.id} value={session.id}>
                {session.title}
              </option>
            ))}
          </select>
          <IconButton
            label="新对话"
            onClick={() => openSession()}
            disabled={streaming || !search.session}
          >
            <PlusIcon aria-hidden className="size-4" />
          </IconButton>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 md:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="hidden min-h-0 border-r border-[var(--border-subtle)] md:flex md:flex-col">
          <div className="flex items-center justify-between px-3 py-2.5">
            <span className="text-xs font-semibold text-[var(--text-secondary)]">
              最近对话
            </span>
            <IconButton
              label="新对话"
              onClick={() => openSession()}
              disabled={streaming}
            >
              <PlusIcon aria-hidden className="size-4" />
            </IconButton>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {sessionsQuery.isError && (
              <p className="px-2 py-3 text-xs text-[var(--danger)]">
                对话列表加载失败
              </p>
            )}
            {(sessionsQuery.data ?? []).map((session) => (
              <button
                key={session.id}
                type="button"
                disabled={streaming}
                onClick={() => openSession(session.id)}
                className={`mb-0.5 flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-xs transition-colors ${
                  session.id === search.session
                    ? "bg-[var(--surface-selected)] text-[var(--text-primary)]"
                    : "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                }`}
              >
                <span className="truncate">{session.title}</span>
                {session.pendingApprovals > 0 && (
                  <span
                    className="size-1.5 shrink-0 rounded-full bg-[var(--attention-mark)]"
                    aria-label="有待审批操作"
                  />
                )}
              </button>
            ))}
          </div>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-4 py-5 sm:px-6">
              {healthQuery.isError ? (
                <AssistantConnectionError
                  onRetry={() => void healthQuery.refetch()}
                />
              ) : !configured && !healthQuery.isLoading ? (
                <AssistantSetupState
                  onOpenSettings={() => void navigate({ to: "/settings" })}
                  onRetry={() => void healthQuery.refetch()}
                />
              ) : historyQuery.isLoading ? (
                <div className="m-auto text-sm text-[var(--text-secondary)]">
                  正在载入对话…
                </div>
              ) : messages.length === 0 &&
                activities.length === 0 &&
                approvals.length === 0 ? (
                <EmptyConversation
                  onChoose={(prompt) => void send(prompt)}
                  disabled={!configured}
                />
              ) : (
                <div className="flex flex-col gap-5">
                  {messages.map((message) => (
                    <MessageBubble key={message.id} message={message} />
                  ))}
                  {activities.map((activity) => (
                    <ToolRow key={activity.id} activity={activity} />
                  ))}
                  {approvals.map((approval) => (
                    <ApprovalRow
                      key={approval.id}
                      approval={approval}
                      onDecide={decide}
                    />
                  ))}
                  {streamError && (
                    <div
                      role="alert"
                      className="flex items-start gap-2 text-sm text-[var(--danger)]"
                    >
                      <ExclamationTriangleIcon
                        aria-hidden
                        className="mt-0.5 size-4 shrink-0"
                      />
                      {streamError}
                    </div>
                  )}
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          </div>

          <div className="shrink-0 border-t border-[var(--border-subtle)] bg-[var(--surface-1)] p-3 sm:px-5">
            <div className="mx-auto flex max-w-3xl items-end gap-2">
              <Textarea
                aria-label="给财务助手发消息"
                rows={2}
                value={draft}
                disabled={!configured || streaming}
                placeholder={
                  activeSession ? "继续这段对话…" : "问账单、消费或分类…"
                }
                className="max-h-36 min-h-12 resize-none"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              <IconButton
                label={streaming ? "正在回复" : "发送"}
                variant="soft"
                disabled={!draft.trim() || !configured || streaming}
                onClick={() => void send()}
                className="mb-2 size-8"
              >
                {streaming ? (
                  <ClockIcon aria-hidden className="size-4 animate-pulse" />
                ) : (
                  <PaperAirplaneIcon aria-hidden className="size-4" />
                )}
              </IconButton>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function EmptyConversation({
  onChoose,
  disabled,
}: {
  onChoose: (prompt: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="m-auto flex w-full max-w-md flex-col items-center py-10 text-center">
      <SparklesIcon aria-hidden className="size-7 text-[var(--brand-text)]" />
      <h2 className="mt-3 text-base font-semibold text-[var(--text-primary)]">
        从账本里直接找答案
      </h2>
      <div className="mt-5 flex w-full flex-col border-y border-[var(--border-subtle)]">
        {STARTERS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            disabled={disabled}
            onClick={() => onChoose(prompt)}
            className="border-b border-[var(--border-subtle)] px-3 py-3 text-left text-sm text-[var(--text-secondary)] transition-colors last:border-b-0 hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  );
}

function AssistantSetupState({
  onOpenSettings,
  onRetry,
}: {
  onOpenSettings: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="m-auto flex max-w-md flex-col items-center py-10 text-center">
      <span className="flex size-11 items-center justify-center rounded-full bg-[var(--brand-soft)] text-[var(--brand-text)]">
        <SparklesIcon aria-hidden className="size-5" />
      </span>
      <h2 className="mt-4 text-base font-semibold text-[var(--text-primary)]">
        连接模型后开始对话
      </h2>
      <p className="mt-1 max-w-sm text-sm leading-6 text-[var(--text-secondary)]">
        财务助手尚未启用。完成模型连接后，就能直接询问账单、消费和分类。
      </p>
      <div className="mt-5 flex items-center gap-2">
        <Button variant="primary" size="sm" onClick={onOpenSettings}>
          查看连接设置
        </Button>
        <Button variant="ghost" size="sm" onClick={onRetry}>
          重新检查
        </Button>
      </div>
    </div>
  );
}

function AssistantConnectionError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="m-auto flex max-w-md flex-col items-center text-center">
      <ExclamationTriangleIcon
        aria-hidden
        className="size-7 text-[var(--attention)]"
      />
      <h2 className="mt-3 text-base font-semibold text-[var(--text-primary)]">
        暂时无法连接财务助手
      </h2>
      <p className="mt-1 text-sm text-[var(--text-secondary)]">
        检查服务状态后再试一次。
      </p>
      <Button className="mt-4" size="sm" onClick={onRetry}>
        重新检查
      </Button>
    </div>
  );
}

function MessageBubble({ message }: { message: AssistantMessage }) {
  if (!message.content && message.role === "assistant") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex h-6 items-center gap-2 text-sm text-[var(--text-secondary)]"
      >
        <SparklesIcon
          aria-hidden
          className="size-4 animate-pulse text-[var(--brand-text)]"
        />
        正在思考…
      </div>
    );
  }
  return (
    <article
      className={message.role === "user" ? "ml-auto max-w-[85%]" : "max-w-full"}
    >
      <div
        className={
          message.role === "user"
            ? "rounded-lg bg-[var(--brand-soft)] px-3 py-2 text-sm text-[var(--text-primary)]"
            : "text-sm leading-6 text-[var(--text-primary)]"
        }
      >
        {message.role === "assistant" ? (
          <Markdown
            skipHtml
            remarkPlugins={[remarkGfm]}
            components={{
              h1: ({ children }) => (
                <h1 className="mb-3 mt-5 text-lg font-semibold first:mt-0">
                  {children}
                </h1>
              ),
              h2: ({ children }) => (
                <h2 className="mb-2 mt-5 text-base font-semibold first:mt-0">
                  {children}
                </h2>
              ),
              h3: ({ children }) => (
                <h3 className="mb-2 mt-4 text-sm font-semibold first:mt-0">
                  {children}
                </h3>
              ),
              p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
              ul: ({ children }) => (
                <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0">
                  {children}
                </ul>
              ),
              ol: ({ children }) => (
                <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0">
                  {children}
                </ol>
              ),
              blockquote: ({ children }) => (
                <blockquote className="my-3 border-l-2 border-[var(--border-strong)] pl-3 text-[var(--text-secondary)]">
                  {children}
                </blockquote>
              ),
              a: ({ children, href }) => (
                <a
                  className="underline underline-offset-2"
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                >
                  {children}
                </a>
              ),
              code: ({ children }) => (
                <code className="rounded bg-[var(--surface-hover)] px-1 py-0.5 font-mono text-[0.9em]">
                  {children}
                </code>
              ),
              pre: ({ children }) => (
                <pre className="my-3 overflow-x-auto rounded-md bg-[var(--surface-hover)] p-3 text-xs leading-5">
                  {children}
                </pre>
              ),
              table: ({ children }) => (
                <table className="my-3 block max-w-full overflow-x-auto border-collapse text-left text-xs">
                  {children}
                </table>
              ),
              th: ({ children }) => (
                <th className="border border-[var(--border-subtle)] bg-[var(--surface-hover)] px-2 py-1.5 font-semibold">
                  {children}
                </th>
              ),
              td: ({ children }) => (
                <td className="border border-[var(--border-subtle)] px-2 py-1.5">
                  {children}
                </td>
              ),
            }}
          >
            {message.content}
          </Markdown>
        ) : (
          message.content
        )}
      </div>
    </article>
  );
}

function ToolRow({ activity }: { activity: ToolActivity }) {
  const Icon =
    activity.state === "running"
      ? ClockIcon
      : activity.state === "error"
        ? XMarkIcon
        : CheckIcon;
  return (
    <div className="flex items-center gap-2 text-xs text-[var(--text-tertiary)]">
      <WrenchScrewdriverIcon aria-hidden className="size-4" />
      <span>
        {CAPABILITY_LABELS[activity.capability] ?? activity.capability}
      </span>
      <Icon
        aria-hidden
        className={`size-3.5 ${activity.state === "running" ? "animate-pulse" : ""}`}
      />
    </div>
  );
}

function ApprovalRow({
  approval,
  onDecide,
}: {
  approval: AssistantApproval;
  onDecide: (
    approval: AssistantApproval,
    decision: "approve" | "reject",
    secret?: string,
  ) => Promise<void>;
}) {
  const [secret, setSecret] = useState("");
  const pending = approval.status === "pending";
  const executing = approval.status === "executing";
  const isSecret = approval.capability === "submit_bill_secret";
  const taskId = String(approval.input.task_id ?? "");

  return (
    <section className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-0)] p-3">
      <div className="flex items-start gap-3">
        {isSecret ? (
          <LockClosedIcon
            aria-hidden
            className="mt-0.5 size-5 shrink-0 text-[var(--attention)]"
          />
        ) : (
          <CheckIcon
            aria-hidden
            className="mt-0.5 size-5 shrink-0 text-[var(--attention)]"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">
              {isSecret ? "账单等待密码" : "账单等待确认导入"}
            </h3>
            <span className="text-[11px] text-[var(--text-tertiary)]">
              {approvalStatus(approval.status)}
            </span>
          </div>
          {taskId && (
            <p className="mt-1 text-xs text-[var(--text-secondary)]">
              任务 #{taskId}
            </p>
          )}
          {isSecret && pending && (
            <Input
              type="password"
              autoComplete="off"
              aria-label="账单密码"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              placeholder="在这里输入密码"
              className="mt-3"
            />
          )}
          {pending && (
            <div className="mt-3 flex items-center justify-end gap-2">
              <Button
                size="xs"
                variant="ghost"
                onClick={() => void onDecide(approval, "reject")}
              >
                拒绝
              </Button>
              <Button
                size="xs"
                variant="primary"
                disabled={isSecret && !secret}
                onClick={() =>
                  void onDecide(
                    approval,
                    "approve",
                    isSecret ? secret : undefined,
                  )
                }
              >
                确认
              </Button>
            </div>
          )}
          {executing && (
            <p className="mt-2 text-xs text-[var(--text-secondary)]">
              正在执行…
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function appendAssistantDelta(
  messages: AssistantMessage[],
  delta: string,
): AssistantMessage[] {
  const next = [...messages];
  for (let index = next.length - 1; index >= 0; index -= 1) {
    if (next[index].role === "assistant") {
      next[index] = { ...next[index], content: next[index].content + delta };
      break;
    }
  }
  return next;
}

function removeEmptyAssistant(
  messages: AssistantMessage[],
): AssistantMessage[] {
  return messages.filter(
    (message) => message.role !== "assistant" || message.content !== "",
  );
}

function approvalStatus(status: AssistantApproval["status"]): string {
  if (status === "pending") return "待确认";
  if (status === "executing") return "执行中";
  if (status === "approved") return "已执行";
  return "已拒绝";
}
