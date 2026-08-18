import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowLeft,
  CaretDown,
  CaretRight,
  ChatTeardropText,
  Check,
  Clock,
  Lock,
  PaperPlaneTilt,
  Plus,
  Sparkle,
  Warning,
  Wrench,
  X,
} from "@phosphor-icons/react";
import {
  decideAssistantApproval,
  getAssistantHealth,
  getAssistantHistory,
  listAssistantSessions,
  streamAssistantMessage,
  type AssistantApproval,
  type AssistantMessage,
  type AssistantSession,
} from "../../api/assistant";
import { useAiRun, useAiRuns } from "../../api/queries";
import type { AiRun, AiRunDetailEntry } from "../../api/schemas";
import { Button, IconButton } from "../../components/ui/Button";
import { ErrorState } from "../../components/abei/ErrorState";
import { Input, Textarea } from "../../components/ui/Field";
import { useCapabilityIndex } from "../../api/queries";
import { needsSecretInput } from "../../api/catalog";
import { formatDateTime } from "../../lib/format";
import { txSearch, type TransactionSearch } from "../../routes/transactionSearch";
import { showToast } from "../../store/toastStore";

const STARTERS = [
  "这个月花了多少？",
  "有哪些账单还没处理？",
  "帮我审阅最新一份账单",
];

/** 回填建议落在交易页的「未分类」视图里。 */
const UNCATEGORIZED_SEARCH = { ...txSearch(), view: "uncategorized" } as TransactionSearch;

interface ToolActivity {
  id: string;
  capability: string;
  /** agent 从目录取好的标签，没有就现拉目录补。 */
  label?: string;
  state: "running" | "done" | "error";
}

/** 需要人当场敲的参数怎么问。目前目录里只有 `secret` 一项。 */
const USER_INPUT_FIELDS: Record<
  string,
  { label: string; placeholder: string; type: "password" | "text" }
> = {
  secret: {
    label: "账单密码",
    placeholder: "在这里输入密码",
    type: "password",
  },
};

function userInputField(name: string) {
  return (
    USER_INPUT_FIELDS[name] ?? {
      label: name,
      placeholder: `在这里输入${name}`,
      type: "text" as const,
    }
  );
}

/**
 * AI 页。
 *
 * 主体是一条工作时间线：阿贝自己跑的活（预填、回填、词表扫描）和你跟它的对话
 * 混在一起按时间倒序排。对话不再是这一页的门面——它只是时间线里的一种条目，
 * 点开才进去。这样「阿贝到底替我干了什么」是一眼能看见的，而不是藏在后台日志里。
 */
export function AssistantPage() {
  const search = useSearch({ from: "/assistant" });
  const navigate = useNavigate({ from: "/assistant" });
  /** 还没有会话 id 的新对话。有 id 之后就跟着 search.session 走。 */
  const [composing, setComposing] = useState(false);

  const healthQuery = useQuery({
    queryKey: ["assistant-health"],
    queryFn: ({ signal }) => getAssistantHealth(signal),
  });
  const configured = healthQuery.data?.configured === true;

  function openSession(session?: string) {
    setComposing(session === undefined);
    void navigate({ search: { session }, replace: true });
  }

  function backToTimeline() {
    setComposing(false);
    void navigate({ search: { session: undefined }, replace: true });
  }

  if (search.session || composing) {
    return (
      <ConversationView
        sessionId={search.session}
        configured={configured}
        healthLoading={healthQuery.isLoading}
        healthError={healthQuery.isError}
        onRetryHealth={() => void healthQuery.refetch()}
        onBack={backToTimeline}
        onSessionCreated={(id) => void navigate({ search: { session: id }, replace: true })}
      />
    );
  }

  return (
    <TimelineView
      configured={configured}
      healthLoading={healthQuery.isLoading}
      healthError={healthQuery.isError}
      onRetryHealth={() => void healthQuery.refetch()}
      onOpenSession={openSession}
      onOpenSettings={() => void navigate({ to: "/settings" })}
    />
  );
}

/* ------------------------------------------------------------------ *
 * 工作时间线
 * ------------------------------------------------------------------ */

type TimelineItem =
  | { key: string; at: string; kind: "run"; run: AiRun }
  | { key: string; at: string; kind: "session"; session: AssistantSession };

function TimelineView({
  configured,
  healthLoading,
  healthError,
  onRetryHealth,
  onOpenSession,
  onOpenSettings,
}: {
  configured: boolean;
  healthLoading: boolean;
  healthError: boolean;
  onRetryHealth: () => void;
  onOpenSession: (session?: string) => void;
  onOpenSettings: () => void;
}) {
  const runsQuery = useAiRuns({ enabled: configured });
  const sessionsQuery = useQuery({
    queryKey: ["assistant-sessions"],
    queryFn: ({ signal }) => listAssistantSessions(signal),
    enabled: configured,
  });

  const items = useMemo<TimelineItem[]>(() => {
    const merged: TimelineItem[] = [
      ...(runsQuery.data ?? []).map((run) => ({
        key: `run-${run.id}`,
        at: run.started_at,
        kind: "run" as const,
        run,
      })),
      ...(sessionsQuery.data ?? []).map((session) => ({
        key: `session-${session.id}`,
        at: session.updatedAt,
        kind: "session" as const,
        session,
      })),
    ];
    return merged.sort((left, right) => right.at.localeCompare(left.at));
  }, [runsQuery.data, sessionsQuery.data]);

  const loading = healthLoading || runsQuery.isLoading || sessionsQuery.isLoading;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-xl font-semibold text-[var(--text-primary)]">
            <Sparkle aria-hidden className="size-5 text-[var(--brand-text)]" />
            AI
          </h1>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            阿贝干过的活都记在这里，你跟它说过的话也在。
          </p>
        </div>
        <Button
          variant="primary"
          size="md"
          disabled={!configured}
          onClick={() => onOpenSession()}
        >
          <Plus aria-hidden className="size-4" />
          问一句
        </Button>
      </div>

      {healthError ? (
        <div className="rounded-lg bg-[var(--surface-1)] p-6 shadow-[var(--shadow-card)] ring-1 ring-[var(--ring-card)]">
          <AssistantConnectionError onRetry={onRetryHealth} />
        </div>
      ) : !configured && !healthLoading ? (
        <div className="rounded-lg bg-[var(--surface-1)] p-6 shadow-[var(--shadow-card)] ring-1 ring-[var(--ring-card)]">
          <AssistantSetupState onOpenSettings={onOpenSettings} onRetry={onRetryHealth} />
        </div>
      ) : loading ? (
        <p role="status" className="py-12 text-center text-sm text-[var(--text-secondary)]">
          正在加载…
        </p>
      ) : runsQuery.isError && sessionsQuery.isError ? (
        <ErrorState
          message="这一页没打开"
          error={runsQuery.error}
          onRetry={() => {
            void runsQuery.refetch();
            void sessionsQuery.refetch();
          }}
        />
      ) : items.length === 0 ? (
        <div className="rounded-lg bg-[var(--surface-1)] px-6 py-14 text-center shadow-[var(--shadow-card)] ring-1 ring-[var(--ring-card)]">
          <Sparkle aria-hidden className="mx-auto size-7 text-[var(--brand-text)]" />
          <h2 className="mt-3 text-base font-semibold text-[var(--text-primary)]">
            阿贝还没干过活
          </h2>
          <p className="mx-auto mt-1 max-w-sm text-sm leading-6 text-[var(--text-secondary)]">
            它替你补分类、补描述、给未分类交易出建议之后，每一轮都会记在这里，
            连依据哪条规则都写清楚。你也可以现在就问它一句。
          </p>
        </div>
      ) : (
        <ul role="list" className="flex flex-col gap-2">
          {items.map((item) =>
            item.kind === "run" ? (
              <RunRow key={item.key} run={item.run} />
            ) : (
              <SessionRow
                key={item.key}
                session={item.session}
                onOpen={() => onOpenSession(item.session.id)}
              />
            ),
          )}
        </ul>
      )}
    </div>
  );
}

const RUN_KIND_LABELS: Record<string, string> = {
  autofill: "预填",
  backfill: "回填",
  vocab_scan: "词表扫描",
  learn: "学规则",
};

/** 每种活干完之后该去哪儿看结果。 */
const RUN_TARGETS: Record<string, { label: string; render: () => ReactElement }> = {
  autofill: {
    label: "去收件箱看",
    render: () => (
      <Link to="/bill-inbox" className={TIMELINE_LINK}>
        去收件箱看
      </Link>
    ),
  },
  backfill: {
    label: "去交易页看",
    render: () => (
      <Link to="/transactions" search={UNCATEGORIZED_SEARCH} className={TIMELINE_LINK}>
        去交易页看
      </Link>
    ),
  },
  vocab_scan: {
    label: "去分类页看",
    render: () => (
      <Link to="/reference-data" className={TIMELINE_LINK}>
        去分类页看
      </Link>
    ),
  },
  learn: {
    label: "去规则文档看",
    render: () => (
      <Link to="/profile" className={TIMELINE_LINK}>
        去规则文档看
      </Link>
    ),
  },
};

const TIMELINE_LINK =
  "shrink-0 text-xs text-[var(--brand-text)] underline underline-offset-2 hover:no-underline";

function numberOf(summary: Record<string, unknown>, key: string): number {
  const value = summary[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** 一行摘要：干了什么、给了多少、其中多少是规则直接判的。 */
export function runSummaryText(run: AiRun): string {
  if (run.status === "failed") return `没跑成：${run.error ?? "原因不明"}`;
  const rows = numberOf(run.summary, "rows");
  const byRule = numberOf(run.summary, "by_rule");
  const byModel = numberOf(run.summary, "by_model") + numberOf(run.summary, "by_doc");
  const split = rows > 0 ? `（规则 ${byRule} / 模型 ${byModel}）` : "";
  if (run.kind === "autofill") return `给 ${rows} 行补了建议${split}`;
  if (run.kind === "backfill") return `给 ${rows} 笔交易出了分类建议${split}`;
  if (run.kind === "vocab_scan") return `提了 ${rows} 条分类建议`;
  if (run.kind === "learn") {
    const learned = numberOf(run.summary, "learned");
    const retired = numberOf(run.summary, "retired");
    const stopped = retired > 0 ? `，停用 ${retired} 条` : "";
    return `往记账规则里加了 ${learned} 条${stopped}`;
  }
  return `产出 ${rows} 条`;
}

function RunRow({ run }: { run: AiRun }) {
  const [expanded, setExpanded] = useState(false);
  const detailQuery = useAiRun(expanded ? run.id : undefined);
  const kindLabel = RUN_KIND_LABELS[run.kind] ?? run.kind;
  const triggerLabel = run.trigger === "manual" ? "手动" : "自动";
  const target = RUN_TARGETS[run.kind];
  const notes = Array.isArray(run.summary.notes) ? (run.summary.notes as string[]) : [];

  return (
    <li className="rounded-lg bg-[var(--surface-1)] shadow-[var(--shadow-card)] ring-1 ring-[var(--ring-card)]">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          {expanded ? (
            <CaretDown aria-hidden className="size-4 shrink-0 text-[var(--text-tertiary)]" />
          ) : (
            <CaretRight aria-hidden className="size-4 shrink-0 text-[var(--text-tertiary)]" />
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-[var(--text-primary)]">
              {kindLabel} · {triggerLabel} · {runSummaryText(run)}
            </span>
            <span className="mt-0.5 block text-[11px] text-[var(--text-tertiary)]">
              {formatDateTime(run.started_at)}
            </span>
          </span>
        </button>
        {target?.render()}
      </div>

      {expanded && (
        <div className="border-t border-[var(--border-subtle)] px-3 py-2.5">
          {notes.length > 0 && (
            <ul role="list" className="mb-2 flex flex-col gap-1">
              {notes.map((note) => (
                <li key={note} className="text-xs text-[var(--attention)]">
                  {note}
                </li>
              ))}
            </ul>
          )}
          {detailQuery.isLoading ? (
            <p role="status" className="text-xs text-[var(--text-secondary)]">
              正在读取明细…
            </p>
          ) : detailQuery.isError ? (
            <ErrorState
              message="明细没读出来"
              error={detailQuery.error}
              onRetry={() => void detailQuery.refetch()}
            />
          ) : (detailQuery.data?.detail ?? []).length === 0 ? (
            <p className="text-xs text-[var(--text-secondary)]">这一轮没有逐条明细。</p>
          ) : (
            <ul role="list" className="flex flex-col gap-1.5">
              {(detailQuery.data?.detail ?? []).map((entry, index) => (
                <RunDetailRow key={`${entry.row_id ?? entry.journal_id ?? index}`} entry={entry} />
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

/** 依据人话：规则命中就把文档里那一行原样摆出来。 */
export function basisText(basis: string): string {
  if (basis.startsWith("rule:")) return `依据规则：${basis.slice("rule:".length)}`;
  if (basis === "doc") return "参考了规则文档";
  if (basis === "scan") return "按账本统计得出";
  if (basis === "learn") return "按你改过的记录得出";
  return "模型判断";
}

function RunDetailRow({ entry }: { entry: AiRunDetailEntry }) {
  const subject =
    entry.description ?? entry.name ?? (entry.row_id ? `第 ${entry.row_id} 行` : entry.journal_id);
  const values = entry.values ?? {};
  const given = Object.entries(values)
    .map(([key, value]) => `${DETAIL_FIELD_LABELS[key] ?? key}：${String(value)}`)
    .join(" · ");
  return (
    <li className="text-xs leading-5">
      <span className="text-[var(--text-primary)]">{subject}</span>
      {given && <span className="text-[var(--text-secondary)]"> — {given}</span>}
      <span className="ml-1 text-[var(--text-tertiary)]">（{basisText(entry.basis)}）</span>
    </li>
  );
}

const DETAIL_FIELD_LABELS: Record<string, string> = {
  category_name: "分类",
  firefly_description: "描述",
  source_name: "转出",
  destination_name: "转入",
  notes: "备注",
};

function SessionRow({
  session,
  onOpen,
}: {
  session: AssistantSession;
  onOpen: () => void;
}) {
  return (
    <li className="rounded-lg bg-[var(--surface-1)] shadow-[var(--shadow-card)] ring-1 ring-[var(--ring-card)]">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-[var(--surface-hover)]"
      >
        <ChatTeardropText aria-hidden className="size-4 shrink-0 text-[var(--text-tertiary)]" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-[var(--text-primary)]">
            对话 · {session.title}
          </span>
          <span className="mt-0.5 block text-[11px] text-[var(--text-tertiary)]">
            {formatDateTime(session.updatedAt)}
          </span>
        </span>
        {session.pendingApprovals > 0 && (
          <span
            className="size-1.5 shrink-0 rounded-full bg-[var(--attention-mark)]"
            aria-label="有待审批操作"
          />
        )}
        <CaretRight aria-hidden className="size-4 shrink-0 text-[var(--text-tertiary)]" />
      </button>
    </li>
  );
}

/* ------------------------------------------------------------------ *
 * 对话：时间线里一条会话点开之后的样子
 * ------------------------------------------------------------------ */

function ConversationView({
  sessionId,
  configured,
  healthLoading,
  healthError,
  onRetryHealth,
  onBack,
  onSessionCreated,
}: {
  sessionId?: string;
  configured: boolean;
  healthLoading: boolean;
  healthError: boolean;
  onRetryHealth: () => void;
  onBack: () => void;
  onSessionCreated: (id: string) => void;
}) {
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

  const historyQuery = useQuery({
    queryKey: ["assistant-history", sessionId],
    queryFn: ({ signal }) => getAssistantHistory(sessionId!, signal),
    enabled: configured && Boolean(sessionId),
  });

  useEffect(() => {
    if (!sessionId) {
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
  }, [sessionId, historyQuery.data]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, approvals, activities]);

  useEffect(() => () => abortRef.current?.abort(), []);

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
    let nextSessionId = sessionId;
    let eventError: string | null = null;

    try {
      await streamAssistantMessage({
        message: prompt,
        sessionId,
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
                label: event.label,
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
      if (nextSessionId && nextSessionId !== sessionId) {
        onSessionCreated(nextSessionId);
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

  /**
   * 页面上这一次点击就是闸门。
   *
   * 模型只拿得到 `dry_run`，`confirm=true` 只从这条路出去（agent 的 decideApproval）。
   * `userInput` 里的密码只在这一次请求里经手：不回显、不进任何本地状态、不落日志。
   */
  async function decide(
    approval: AssistantApproval,
    decision: "approve" | "reject",
    userInput?: Record<string, string>,
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
        userInput,
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
        <div className="flex min-w-0 items-center gap-2">
          <IconButton label="回到时间线" onClick={onBack} disabled={streaming}>
            <ArrowLeft aria-hidden className="size-4" />
          </IconButton>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold text-[var(--text-primary)]">
              {historyQuery.data?.session.title ?? "新对话"}
            </h1>
            {/* 模型型号只在设置页出现（设计稿 03 §3）：聊天页顶上顶着一串
                `openai · gpt-5.6-sol`，对着它聊天的人一次也用不上。 */}
            <p className="mt-0.5 truncate text-[11px] text-[var(--text-tertiary)]">
              {healthLoading
                ? "正在连接模型"
                : configured
                  ? "已连接"
                  : healthError
                    ? "连接中断"
                    : "尚未启用"}
            </p>
          </div>
        </div>
      </header>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-4 py-5 sm:px-6">
            {healthError ? (
              <AssistantConnectionError onRetry={onRetryHealth} />
            ) : !configured && !healthLoading ? (
              <AssistantSetupState
                onOpenSettings={() => void navigate({ to: "/settings" })}
                onRetry={onRetryHealth}
              />
            ) : historyQuery.isLoading ? (
              <div className="m-auto text-sm text-[var(--text-secondary)]">
                正在载入对话…
              </div>
            ) : historyQuery.isError ? (
              // 不处理的话会落到下面的「空对话」分支，看起来像这段记录被清空了
              <div className="m-auto w-full max-w-sm">
                <ErrorState
                  message="这段对话没能打开"
                  error={historyQuery.error}
                  onRetry={() => void historyQuery.refetch()}
                />
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
                    <Warning aria-hidden className="mt-0.5 size-4 shrink-0" />
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
              aria-label="给阿贝发消息"
              rows={2}
              value={draft}
              disabled={!configured || streaming}
              placeholder={sessionId ? "继续这段对话…" : "问账单、消费或分类…"}
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
                <Clock aria-hidden className="size-4 animate-pulse" />
              ) : (
                <PaperPlaneTilt aria-hidden className="size-4" />
              )}
            </IconButton>
          </div>
        </div>
      </section>
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
      <Sparkle aria-hidden className="size-7 text-[var(--brand-text)]" />
      <h2 className="mt-3 text-base font-semibold text-[var(--text-primary)]">
        基于当前账本回答
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
        <Sparkle aria-hidden className="size-5" />
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
      <Warning
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
        <Sparkle
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
  // 标签一律出自能力目录：agent 事件里已经带了一份（同源），没带就自己拉目录补。
  // 这里不留手写副本——副本会在服务端改字之后一声不响地说旧话。
  const { labelFor } = useCapabilityIndex();
  const Icon =
    activity.state === "running"
      ? Clock
      : activity.state === "error"
        ? X
        : Check;
  return (
    <div className="flex items-center gap-2 text-xs text-[var(--text-tertiary)]">
      <Wrench aria-hidden className="size-4" />
      <span>{activity.label ?? labelFor(activity.capability)}</span>
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
    userInput?: Record<string, string>,
  ) => Promise<void>;
}) {
  /**
   * 人当场填的值。只活在这一张卡里，提交完就清空；不写 localStorage，
   * 也不会跟着审批记录进任何缓存。
   */
  const [entries, setEntries] = useState<Record<string, string>>({});
  const pending = approval.status === "pending";
  const executing = approval.status === "executing";
  // 标签和「缺哪几项要人填」都出自能力目录：agent 已经在审批载荷里带了一份，
  // 老会话的历史里没有就自己拉目录补。页面不按能力名写死分支。
  const { index, labelFor } = useCapabilityIndex();
  const capability = index.get(approval.capability);
  const title = approval.label ?? labelFor(approval.capability);
  const needs =
    approval.needs_user_input ?? (needsSecretInput(capability) ? ["secret"] : []);
  const needsInput = needs.length > 0;
  const filled = needs.every((name) => (entries[name] ?? "").trim() !== "");
  // 目录里的 id 参数就是这条能力作用的对象（账单 id）。
  const targetId = String(approval.input.id ?? "");
  // 要人填参数的能力干跑不了，预览必然是空的——那是正常状态，别当出错渲染。
  const previewText = describePreview(approval.preview);

  function approve() {
    const userInput = needsInput
      ? Object.fromEntries(needs.map((name) => [name, entries[name] ?? ""]))
      : undefined;
    setEntries({});
    void onDecide(approval, "approve", userInput);
  }

  return (
    <section className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-0)] p-3">
      <div className="flex items-start gap-3">
        {needsInput ? (
          <Lock
            aria-hidden
            className="mt-0.5 size-5 shrink-0 text-[var(--attention)]"
          />
        ) : (
          <Check
            aria-hidden
            className="mt-0.5 size-5 shrink-0 text-[var(--attention)]"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">
              {needsInput
                ? `${title}，等待你填写并确认`
                : `${title}，等待你确认`}
            </h3>
            <span className="text-[11px] text-[var(--text-tertiary)]">
              {approvalStatus(approval.status)}
            </span>
          </div>
          {targetId && (
            <p className="mt-1 text-xs text-[var(--text-secondary)]">
              账单 #{targetId}
            </p>
          )}
          {previewText ? (
            <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-[var(--surface-hover)] p-2 text-[11px] leading-5 text-[var(--text-secondary)]">
              {previewText}
            </pre>
          ) : (
            pending && (
              <p className="mt-2 text-xs text-[var(--text-secondary)]">
                {needsInput
                  ? "这一步要先填好，确认后才会执行。"
                  : "确认后才会执行。"}
              </p>
            )
          )}
          {pending &&
            needs.map((name) => {
              const field = userInputField(name);
              return (
                <Input
                  key={name}
                  type={field.type}
                  autoComplete="off"
                  aria-label={field.label}
                  value={entries[name] ?? ""}
                  onChange={(event) =>
                    setEntries((current) => ({
                      ...current,
                      [name]: event.target.value,
                    }))
                  }
                  placeholder={field.placeholder}
                  className="mt-3"
                />
              );
            })}
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
                disabled={!filled}
                onClick={approve}
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

/** 干跑预览转成可读文本；空预览返回 null（要人填参数的能力干跑不了）。 */
function describePreview(preview: unknown): string | null {
  if (preview === null || preview === undefined) return null;
  if (typeof preview === "string") return preview.trim() || null;
  try {
    const text = JSON.stringify(preview, null, 2);
    return text && text !== "{}" ? text : null;
  } catch {
    return null;
  }
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
