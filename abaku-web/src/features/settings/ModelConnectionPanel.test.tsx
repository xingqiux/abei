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
}));

vi.mock("../../api/assistant", () => ({
  getAssistantHealth: mocks.getHealth,
  listAssistantModels: mocks.listModels,
  saveAssistantModelConfig: mocks.save,
  deleteAssistantModelConfig: mocks.remove,
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
});
