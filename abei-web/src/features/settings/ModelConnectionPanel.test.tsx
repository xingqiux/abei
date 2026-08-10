import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ModelConnectionPanel } from "./ModelConnectionPanel";

const mocks = vi.hoisted(() => ({
  getHealth: vi.fn(),
  listModels: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
  toast: vi.fn(),
  getAutofill: vi.fn(),
  saveAutofill: vi.fn(),
}));

vi.mock("../../api/assistant", () => ({
  getAssistantHealth: mocks.getHealth,
  listAssistantModels: mocks.listModels,
  saveAssistantModelConfig: mocks.save,
  deleteAssistantModelConfig: mocks.remove,
  getAutofillConfig: mocks.getAutofill,
  saveAutofillConfig: mocks.saveAutofill,
}));
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  getActiveToken: () => "pat-abc",
}));

vi.mock("../../store/toastStore", () => ({ showToast: mocks.toast }));

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ModelConnectionPanel />
    </QueryClientProvider>,
  );
}

describe("ModelConnectionPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getHealth.mockResolvedValue({
      status: "ok",
      configured: false,
      source: "environment",
      provider: "openai",
      model: "gpt-5.4-mini",
    });
    mocks.save.mockResolvedValue({
      status: "ok",
      configured: true,
      source: "saved",
      provider: "openai",
      model: "gpt-5.4-mini",
    });
    mocks.listModels.mockResolvedValue(["gpt-5.6-sol", "gpt-5.4-mini"]);
    mocks.getAutofill.mockResolvedValue({
      enabled: false,
      interval_seconds: 300,
      has_token: false,
    });
    mocks.saveAutofill.mockResolvedValue({
      enabled: true,
      interval_seconds: 300,
      has_token: true,
    });
  });

  test("opens a real model form and saves the provider credential", async () => {
    renderPanel();

    await screen.findByText("尚未连接模型。");
    fireEvent.click(screen.getByRole("button", { name: "连接模型" }));
    const dialog = await screen.findByRole("dialog", { name: "连接模型" });
    fireEvent.change(within(dialog).getByLabelText("API Key"), {
      target: { value: "sk-test" },
    });
    await waitFor(() =>
      expect(mocks.listModels).toHaveBeenCalledWith(
        { provider: "openai", apiToken: "sk-test" },
        expect.any(AbortSignal),
      ),
    );
    fireEvent.change(within(dialog).getByLabelText("模型 ID"), {
      target: { value: "gpt-5.6-sol" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存并启用" }));

    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith({
        provider: "openai",
        model: "gpt-5.6-sol",
        apiToken: "sk-test",
      }),
    );
    expect(mocks.toast).toHaveBeenCalledWith({
      kind: "success",
      message: "模型配置已保存",
    });
  });

  test("discovers models with the current environment credential", async () => {
    mocks.getHealth.mockResolvedValue({
      status: "ok",
      configured: true,
      source: "environment",
      provider: "openai",
      model: "gpt-5.4-mini",
      apiUrl: "https://models.example/v1",
    });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "更换模型" }));

    await waitFor(() =>
      expect(mocks.listModels).toHaveBeenCalledWith(
        {
          provider: "openai",
          apiUrl: "https://models.example/v1",
        },
        expect.any(AbortSignal),
      ),
    );
  });

  test("keeps autofill locked until a model is connected", async () => {
    renderPanel();

    expect(await screen.findByText("需先连接模型。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开启" })).toBeDisabled();
  });

  test("hands the current token over the first time autofill is enabled", async () => {
    mocks.getHealth.mockResolvedValue({
      status: "ok",
      configured: true,
      source: "saved",
      provider: "openai",
      model: "gpt-5.4-mini",
    });
    renderPanel();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "开启" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "开启" }));

    await waitFor(() =>
      expect(mocks.saveAutofill).toHaveBeenCalledWith({
        enabled: true,
        token: "pat-abc",
      }),
    );
    expect(await screen.findByRole("button", { name: "关闭" })).toBeEnabled();
  });

  test("does not resend the token when the service already stored one", async () => {
    mocks.getHealth.mockResolvedValue({
      status: "ok",
      configured: true,
      source: "saved",
      provider: "openai",
      model: "gpt-5.4-mini",
    });
    mocks.getAutofill.mockResolvedValue({
      enabled: true,
      interval_seconds: 600,
      has_token: true,
    });
    mocks.saveAutofill.mockResolvedValue({
      enabled: false,
      interval_seconds: 600,
      has_token: true,
    });
    renderPanel();

    expect(
      await screen.findByText(
        "每 10 分钟为收件箱中的流水补全分类、描述与备注；入账仍需确认。",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    await waitFor(() =>
      expect(mocks.saveAutofill).toHaveBeenCalledWith({ enabled: false }),
    );
  });
});
