import { afterEach, describe, expect, test, vi } from "vitest";
import {
  decideAssistantApproval,
  getAssistantHealth,
  listAssistantModels,
  saveAssistantModelConfig,
  streamAssistantMessage,
} from "./assistant";
import { clearStoredToken, setStoredToken } from "./client";

afterEach(() => {
  clearStoredToken();
  vi.restoreAllMocks();
});

describe("assistant API", () => {
  test("reads and saves the current user model config with the Firefly PAT", async () => {
    setStoredToken("current-pat");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ status: "ok", configured: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await getAssistantHealth();
    await saveAssistantModelConfig({
      provider: "openai",
      model: "gpt-5.6-terra",
      apiToken: "sk-secret",
    });

    expect(fetchMock.mock.calls[0]).toEqual([
      "/api/ai/config",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer current-pat",
        }),
      }),
    ]);
    expect(fetchMock.mock.calls[1]).toEqual([
      "/api/ai/config",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          Authorization: "Bearer current-pat",
        }),
      }),
    ]);
  });

  test("asks the local agent to discover upstream models", async () => {
    setStoredToken("current-pat");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: ["model-a", "model-b"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      listAssistantModels({
        provider: "openai",
        apiToken: "sk-secret",
        apiUrl: "https://models.example/v1",
      }),
    ).resolves.toEqual(["model-a", "model-b"]);

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(fetchMock.mock.calls[0][0]).toBe("/api/ai/models");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      provider: "openai",
      apiToken: "sk-secret",
      apiUrl: "https://models.example/v1",
    });
  });

  test("parses split NDJSON events and forwards the current Firefly PAT", async () => {
    setStoredToken("current-pat");
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            '{"type":"meta","session_id":"s","provider":"openai","model":"m"}\n{"type":"text_',
          ),
        );
        controller.enqueue(
          encoder.encode(
            'delta","delta":"你好"}\n{"type":"done","session_id":"s"}\n',
          ),
        );
        controller.close();
      },
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      }),
    );
    const events: unknown[] = [];

    await streamAssistantMessage({
      message: "本月花了多少",
      onEvent: (event) => events.push(event),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/ai/chat",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer current-pat",
        }),
      }),
    );
    expect(events).toEqual([
      { type: "meta", session_id: "s", provider: "openai", model: "m" },
      { type: "text_delta", delta: "你好" },
      { type: "done", session_id: "s" },
    ]);
  });

  test("submits a bill secret only through the approval endpoint", async () => {
    setStoredToken("current-pat");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { id: "a", status: "approved" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await decideAssistantApproval("a", "approve", { secret: "123456" });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(fetchMock.mock.calls[0][0]).toBe("/api/ai/approvals/a");
    expect(JSON.parse(String(init.body))).toEqual({
      decision: "approve",
      user_input: { secret: "123456" },
    });
  });
});
