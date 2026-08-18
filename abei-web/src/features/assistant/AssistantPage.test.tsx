import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { AssistantPage, basisText, runSummaryText } from "./AssistantPage";
import type { AiRun } from "../../api/schemas";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  getHealth: vi.fn(),
  listSessions: vi.fn(),
  streamMessage: vi.fn(),
  getAiRuns: vi.fn(),
  getAiRun: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useSearch: () => ({}),
  useNavigate: () => mocks.navigate,
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
}));

vi.mock("../../api/assistant", () => ({
  getAssistantHealth: mocks.getHealth,
  listAssistantSessions: mocks.listSessions,
  getAssistantHistory: vi.fn(),
  streamAssistantMessage: mocks.streamMessage,
  decideAssistantApproval: vi.fn(),
  getAiRuns: mocks.getAiRuns,
  getAiRun: mocks.getAiRun,
}));

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AssistantPage />
    </QueryClientProvider>,
  );
}

/** 时间线是页面主体，对话要先点「问一句」才进得去。 */
async function openComposer() {
  const button = await screen.findByRole("button", { name: "问一句" });
  // 模型没连上之前这个按钮是灰的，点了不算数
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  return screen.findByLabelText("给阿贝发消息");
}

describe("AssistantPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    mocks.getHealth.mockResolvedValue({
      status: "ok",
      configured: true,
      source: "saved",
      provider: "openai",
      model: "gpt-5.6-sol",
    });
    mocks.listSessions.mockResolvedValue([]);
    mocks.getAiRuns.mockResolvedValue([]);
    mocks.getAiRun.mockResolvedValue(null);
    mocks.streamMessage.mockImplementation(() => new Promise(() => {}));
  });

  test("shows a waiting state before the first AI response", async () => {
    renderPage();

    const input = await openComposer();
    fireEvent.change(input, { target: { value: "测试" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByRole("status")).toHaveTextContent("正在思考…");
  });

  test("renders AI replies as Markdown", async () => {
    mocks.streamMessage.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: "text_delta", delta: "**重点**\n\n- 第一项" });
    });
    renderPage();

    const input = await openComposer();
    fireEvent.change(input, { target: { value: "测试 Markdown" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByText("重点")).toHaveProperty("tagName", "STRONG");
    expect(screen.getByRole("listitem")).toHaveTextContent("第一项");
  });

  test("一轮跑批在时间线上是一条，展开才拉明细", async () => {
    mocks.getAiRuns.mockResolvedValue([
      {
        id: "11111111-1111-1111-1111-111111111111",
        kind: "autofill",
        trigger: "auto",
        started_at: "2026-08-14T10:00:00.000Z",
        status: "succeeded",
        summary: { rows: 25, by_rule: 18, by_model: 7 },
      },
    ] satisfies AiRun[]);
    mocks.getAiRun.mockResolvedValue({
      id: "11111111-1111-1111-1111-111111111111",
      kind: "autofill",
      trigger: "auto",
      started_at: "2026-08-14T10:00:00.000Z",
      status: "succeeded",
      summary: { rows: 25, by_rule: 18, by_model: 7 },
      detail: [
        {
          kind: "bill_row",
          row_id: "row-1",
          description: "滴滴出行",
          values: { category_name: "交通出行" },
          basis: "rule:- 商户名含「滴滴」 → 交通出行",
        },
      ],
    } satisfies AiRun);
    renderPage();

    const row = await screen.findByRole("button", {
      name: /预填 · 自动 · 给 25 行补了建议（规则 18 \/ 模型 7）/,
    });
    // 明细是点开才要的，列表里不该先拉一遍
    expect(mocks.getAiRun).not.toHaveBeenCalled();

    fireEvent.click(row);
    expect(await screen.findByText(/依据规则：- 商户名含「滴滴」 → 交通出行/)).toBeInTheDocument();
  });

  test("什么都没跑过时说清这一页是干嘛的", async () => {
    renderPage();
    expect(await screen.findByText("阿贝还没干过活")).toBeInTheDocument();
  });
});

describe("runSummaryText", () => {
  const base: AiRun = {
    id: "run-1",
    kind: "autofill",
    trigger: "auto",
    started_at: "2026-08-14T10:00:00.000Z",
    status: "succeeded",
    summary: {},
  };

  test("按种类说人话", () => {
    expect(runSummaryText({ ...base, summary: { rows: 25, by_rule: 18, by_model: 7 } })).toBe(
      "给 25 行补了建议（规则 18 / 模型 7）",
    );
    expect(
      runSummaryText({ ...base, kind: "backfill", summary: { rows: 3, by_rule: 0, by_model: 3 } }),
    ).toBe("给 3 笔交易出了分类建议（规则 0 / 模型 3）");
    expect(runSummaryText({ ...base, kind: "vocab_scan", summary: { rows: 2 } })).toBe(
      "提了 2 条分类建议",
    );
    expect(
      runSummaryText({ ...base, kind: "learn", summary: { learned: 2, retired: 1 } }),
    ).toBe("往记账规则里加了 2 条，停用 1 条");
    expect(runSummaryText({ ...base, kind: "learn", summary: { learned: 1, retired: 0 } })).toBe(
      "往记账规则里加了 1 条",
    );
  });

  test("失败的那轮直接把原因摆出来", () => {
    expect(runSummaryText({ ...base, status: "failed", error: "模型没配" })).toBe(
      "没跑成：模型没配",
    );
  });
});

describe("basisText", () => {
  test("规则命中把文档里那一行原样摆出来", () => {
    expect(basisText("rule:- 商户名含「滴滴」 → 交通出行")).toBe(
      "依据规则：- 商户名含「滴滴」 → 交通出行",
    );
    expect(basisText("doc")).toBe("参考了规则文档");
    expect(basisText("scan")).toBe("按账本统计得出");
    expect(basisText("learn")).toBe("按你改过的记录得出");
    expect(basisText("model")).toBe("模型判断");
  });
});
