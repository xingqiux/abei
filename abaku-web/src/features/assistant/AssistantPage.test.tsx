import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { AssistantPage } from "./AssistantPage";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  getHealth: vi.fn(),
  listSessions: vi.fn(),
  streamMessage: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useSearch: () => ({}),
  useNavigate: () => mocks.navigate,
}));

vi.mock("../../api/assistant", () => ({
  getAssistantHealth: mocks.getHealth,
  listAssistantSessions: mocks.listSessions,
  getAssistantHistory: vi.fn(),
  streamAssistantMessage: mocks.streamMessage,
  decideAssistantApproval: vi.fn(),
}));

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
    mocks.streamMessage.mockImplementation(() => new Promise(() => {}));
  });

  test("shows a waiting state before the first AI response", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <AssistantPage />
      </QueryClientProvider>,
    );

    const input = await screen.findByLabelText("给财务助手发消息");
    fireEvent.change(input, { target: { value: "测试" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByRole("status")).toHaveTextContent("正在思考…");
  });

  test("renders AI replies as Markdown", async () => {
    mocks.streamMessage.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: "text_delta", delta: "**重点**\n\n- 第一项" });
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <AssistantPage />
      </QueryClientProvider>,
    );

    const input = await screen.findByLabelText("给财务助手发消息");
    fireEvent.change(input, { target: { value: "测试 Markdown" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByText("重点")).toHaveProperty("tagName", "STRONG");
    expect(screen.getByRole("listitem")).toHaveTextContent("第一项");
  });
});
