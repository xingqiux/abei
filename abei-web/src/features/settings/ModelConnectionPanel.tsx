import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowsClockwise, LinkSimple } from "@phosphor-icons/react";
import {
  deleteAssistantModelConfig,
  getAssistantHealth,
  getAutofillConfig,
  listAssistantModels,
  saveAssistantModelConfig,
  saveAutofillConfig,
  type AssistantHealth,
  type AssistantModelDiscoveryInput,
  type AssistantModelProvider,
} from "../../api/assistant";
import { getActiveToken } from "../../api/client";
import { Modal } from "../../components/abei/Modal";
import { Button } from "../../components/ui/Button";
import { Field, Input, Select } from "../../components/ui/Field";
import { showToast } from "../../store/toastStore";

const PROVIDERS: Array<{
  id: AssistantModelProvider;
  label: string;
}> = [
  { id: "openai", label: "OpenAI / 兼容服务" },
  { id: "anthropic", label: "Anthropic" },
  { id: "google", label: "Google" },
  { id: "cloudflare-ai-gateway", label: "Cloudflare AI Gateway" },
  { id: "cloudflare-workers-ai", label: "Cloudflare Workers AI" },
  { id: "ollama", label: "Ollama" },
];

interface ModelForm {
  provider: AssistantModelProvider;
  model: string;
  apiToken: string;
  apiUrl: string;
  accountId: string;
  gatewayId: string;
}

export function ModelConnectionPanel() {
  const queryClient = useQueryClient();
  const health = useQuery({
    queryKey: ["assistant-health"],
    queryFn: ({ signal }) => getAssistantHealth(signal),
  });
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<ModelForm>(() => emptyForm("openai"));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [models, setModels] = useState<string[]>([]);
  const [modelState, setModelState] = useState<
    "idle" | "loading" | "loaded" | "error"
  >("idle");
  const [modelError, setModelError] = useState("");
  const [modelRequest, setModelRequest] = useState(0);

  const current = health.data;
  const provider = PROVIDERS.find((item) => item.id === current?.provider);

  function openForm() {
    const selected = provider?.id ?? "openai";
    setForm({
      provider: selected,
      model: current?.configured ? current.model : "",
      apiToken: "",
      apiUrl: current?.apiUrl ?? defaultApiUrl(selected),
      accountId: current?.accountId ?? "",
      gatewayId: current?.gatewayId ?? "",
    });
    setErrors({});
    setModels([]);
    setModelState("idle");
    setModelError("");
    setOpen(true);
  }

  function set<K extends keyof ModelForm>(key: K, value: ModelForm[K]) {
    setForm((old) => ({ ...old, [key]: value }));
    setErrors((old) => ({ ...old, [key]: "" }));
  }

  function changeProvider(next: AssistantModelProvider) {
    setForm(emptyForm(next));
    setErrors({});
    setModels([]);
    setModelState("idle");
    setModelError("");
  }

  useEffect(() => {
    const input = modelDiscoveryInput(form, current);
    if (!open || !input) {
      setModels([]);
      setModelState("idle");
      setModelError("");
      return;
    }

    const controller = new AbortController();
    setModelState("loading");
    setModelError("");
    const timer = window.setTimeout(() => {
      void listAssistantModels(input, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return;
          setModels(result);
          setModelState(result.length > 0 ? "loaded" : "error");
          setModelError(result.length > 0 ? "" : "上游没有返回可用模型");
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setModels([]);
          setModelState("error");
          setModelError(
            error instanceof Error ? error.message : "模型列表读取失败",
          );
        });
    }, 250);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // Changing only the selected model must not refetch the discovery list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    open,
    form.provider,
    form.apiToken,
    form.apiUrl,
    form.accountId,
    form.gatewayId,
    current?.source,
    current?.provider,
    modelRequest,
  ]);

  async function save() {
    const nextErrors = validate(form, current);
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    setSaving(true);
    try {
      const updated = await saveAssistantModelConfig({
        provider: form.provider,
        model: form.model.trim(),
        ...(form.apiToken.trim() ? { apiToken: form.apiToken.trim() } : {}),
        ...(form.apiUrl.trim() ? { apiUrl: form.apiUrl.trim() } : {}),
        ...(form.accountId.trim() ? { accountId: form.accountId.trim() } : {}),
        ...(form.gatewayId.trim() ? { gatewayId: form.gatewayId.trim() } : {}),
      });
      queryClient.setQueryData(["assistant-health"], updated);
      setOpen(false);
      showToast({ kind: "success", message: "模型配置已保存" });
    } catch (error) {
      showToast({
        kind: "error",
        message: error instanceof Error ? error.message : "模型配置保存失败",
      });
    } finally {
      setSaving(false);
    }
  }

  async function disconnect() {
    if (!window.confirm("断开当前模型？环境中配置的默认模型仍可能继续生效。"))
      return;
    try {
      const updated = await deleteAssistantModelConfig();
      queryClient.setQueryData(["assistant-health"], updated);
      showToast({ kind: "success", message: "已移除当前模型配置" });
    } catch (error) {
      showToast({
        kind: "error",
        message: error instanceof Error ? error.message : "断开失败",
      });
    }
  }

  return (
    <>
      <div className="mb-5 flex flex-col gap-3 border-b border-[var(--border-subtle)] pb-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span
            aria-hidden
            className={`mt-1.5 size-2.5 shrink-0 rounded-full ${current?.configured ? "bg-[var(--done)]" : "bg-[var(--text-tertiary)]"}`}
          />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">
              财务助手
            </h3>
            <p className="mt-0.5 text-xs leading-5 text-[var(--text-secondary)]">
              {health.isLoading
                ? "正在读取模型配置…"
                : health.isError
                  ? "模型配置读取失败"
                  : current?.configured
                    ? `已配置 ${provider?.label ?? current.provider} · ${current.model}`
                    : "尚未连接模型。"}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {health.isError && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => void health.refetch()}
            >
              重试
            </Button>
          )}
          {current?.source === "saved" && (
            <Button
              size="xs"
              variant="ghost-danger"
              onClick={() => void disconnect()}
            >
              断开
            </Button>
          )}
          <Button
            size="xs"
            variant="primary"
            disabled={health.isLoading}
            onClick={openForm}
          >
            <LinkSimple aria-hidden className="size-3.5" />
            {current?.configured ? "更换模型" : "连接模型"}
          </Button>
        </div>
      </div>

      <AutofillToggle modelConfigured={!!current?.configured} />

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={current?.configured ? "更换模型" : "连接模型"}
        width={520}
        footer={
          <>
            <Button
              variant="ghost"
              disabled={saving}
              onClick={() => setOpen(false)}
            >
              取消
            </Button>
            <Button
              variant="primary"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? "保存中…" : "保存并启用"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="供应商" error={errors.provider}>
            <Select
              value={form.provider}
              onChange={(event) =>
                changeProvider(event.target.value as AssistantModelProvider)
              }
            >
              {PROVIDERS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="API Key"
            error={errors.apiToken}
            hint={
              current?.configured && current.provider === form.provider
                ? "留空会保留当前密钥。"
                : form.provider === "ollama"
                  ? "本地服务没有鉴权时可以留空。"
                  : undefined
            }
          >
            <Input
              type="password"
              autoComplete="new-password"
              value={form.apiToken}
              onChange={(event) => set("apiToken", event.target.value)}
            />
          </Field>

          {usesApiUrl(form.provider) && (
            <Field
              label="API 地址"
              error={errors.apiUrl}
              hint={
                form.provider === "openai"
                  ? "使用 OpenAI 兼容代理时填写；官方服务可留空。"
                  : undefined
              }
            >
              <Input
                type="url"
                placeholder={defaultApiUrl(form.provider) || "https://…"}
                value={form.apiUrl}
                onChange={(event) => set("apiUrl", event.target.value)}
              />
            </Field>
          )}

          {form.provider.startsWith("cloudflare-") && (
            <Field label="Cloudflare Account ID" error={errors.accountId}>
              <Input
                value={form.accountId}
                onChange={(event) => set("accountId", event.target.value)}
              />
            </Field>
          )}

          {form.provider === "cloudflare-ai-gateway" && (
            <Field label="Cloudflare Gateway ID" error={errors.gatewayId}>
              <Input
                value={form.gatewayId}
                onChange={(event) => set("gatewayId", event.target.value)}
              />
            </Field>
          )}

          <Field
            label="模型 ID"
            error={errors.model}
            hint={modelHint(modelState, models.length, modelError)}
          >
            <div className="flex items-center gap-2">
              <Input
                list="assistant-model-options"
                value={form.model}
                onChange={(event) => set("model", event.target.value)}
              />
              <Button
                size="sm"
                variant="secondary"
                disabled={
                  modelState === "loading" ||
                  !modelDiscoveryInput(form, current)
                }
                onClick={() => setModelRequest((value) => value + 1)}
              >
                <ArrowsClockwise
                  aria-hidden
                  className={`size-4 ${modelState === "loading" ? "animate-spin" : ""}`}
                />
                刷新模型
              </Button>
            </div>
          </Field>
          <datalist id="assistant-model-options">
            {models.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
        </div>
      </Modal>
    </>
  );
}

/**
 * AI 自动预填总开关（设计稿 03 §2）。
 *
 * 打开时要把当前的 Firefly PAT 交给 abei-agent —— worker 是在后台替人回写
 * 建议的，没有令牌它谁也不是。所以这个开关必须由人在这里主动打开，
 * 不能默认帮人开。
 */
function AutofillToggle({ modelConfigured }: { modelConfigured: boolean }) {
  const queryClient = useQueryClient();
  const config = useQuery({
    queryKey: ["assistant-autofill-config"],
    queryFn: ({ signal }) => getAutofillConfig(signal),
  });
  const [saving, setSaving] = useState(false);
  const enabled = config.data?.enabled ?? false;
  const hasToken = config.data?.has_token ?? false;
  const intervalMinutes = Math.round((config.data?.interval_seconds ?? 300) / 60);

  async function toggle(next: boolean) {
    setSaving(true);
    try {
      const updated = await saveAutofillConfig({
        enabled: next,
        // 后端还没存过令牌时才补送一次；关掉更不用送。
        // 每次都送等于把 PAT 无谓地多过一遍网络。
        ...(next && !hasToken ? { token: getActiveToken() } : {}),
      });
      queryClient.setQueryData(["assistant-autofill-config"], updated);
      showToast({
        kind: "success",
        message: next ? "已开启 AI 自动预填" : "已关闭 AI 自动预填",
      });
    } catch (error) {
      showToast({
        kind: "error",
        message: error instanceof Error ? error.message : "开关切换失败",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mb-5 flex flex-col gap-3 border-b border-[var(--border-subtle)] pb-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <span
          aria-hidden
          className={`mt-1.5 size-2.5 shrink-0 rounded-full ${enabled ? "bg-[var(--done)]" : "bg-[var(--text-tertiary)]"}`}
        />
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
            AI 自动预填
          </h3>
          <p className="mt-0.5 text-xs leading-5 text-[var(--text-secondary)]">
            {config.isLoading
              ? "正在读取…"
              : config.isError
                ? "读取失败，AI 服务可能未启动"
                : !modelConfigured
                  ? "需先连接模型。"
                  : enabled
                    ? `每 ${intervalMinutes} 分钟为收件箱中的流水补全分类、描述与备注；入账仍需确认。`
                    : "开启后，后台为收件箱中的流水补全分类、描述与备注；入账仍需确认。开启需将当前令牌交给 AI 服务。"}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {config.isError && (
          <Button size="xs" variant="ghost" onClick={() => void config.refetch()}>
            重试
          </Button>
        )}
        <Button
          size="xs"
          variant={enabled ? "ghost-danger" : "primary"}
          disabled={saving || config.isLoading || (!enabled && !modelConfigured)}
          onClick={() => void toggle(!enabled)}
        >
          {saving ? "处理中…" : enabled ? "关闭" : "开启"}
        </Button>
      </div>
    </div>
  );
}

function emptyForm(provider: AssistantModelProvider): ModelForm {
  return {
    provider,
    model: "",
    apiToken: "",
    apiUrl: defaultApiUrl(provider),
    accountId: "",
    gatewayId: "",
  };
}

function modelDiscoveryInput(
  form: ModelForm,
  current?: AssistantHealth,
): AssistantModelDiscoveryInput | null {
  const keepsCurrentToken =
    current?.configured && current.provider === form.provider;
  if (
    form.provider !== "ollama" &&
    !form.apiToken.trim() &&
    !keepsCurrentToken
  ) {
    return null;
  }
  if (form.provider === "ollama" && !form.apiUrl.trim()) return null;
  if (form.provider.startsWith("cloudflare-") && !form.accountId.trim()) {
    return null;
  }
  if (form.provider === "cloudflare-ai-gateway" && !form.gatewayId.trim()) {
    return null;
  }
  return {
    provider: form.provider,
    ...(form.apiToken.trim() ? { apiToken: form.apiToken.trim() } : {}),
    ...(form.apiUrl.trim() ? { apiUrl: form.apiUrl.trim() } : {}),
    ...(form.accountId.trim() ? { accountId: form.accountId.trim() } : {}),
    ...(form.gatewayId.trim() ? { gatewayId: form.gatewayId.trim() } : {}),
  };
}

function modelHint(
  state: "idle" | "loading" | "loaded" | "error",
  count: number,
  error: string,
): string {
  if (state === "loading") return "正在从上游读取模型…";
  if (state === "loaded") return `已从上游读取 ${count} 个模型，也可手动填写。`;
  if (state === "error") return `${error}；仍可手动填写。`;
  return "填写连接信息后会自动读取上游模型，也可手动填写。";
}

function defaultApiUrl(provider: AssistantModelProvider): string {
  return provider === "ollama" ? "http://host.docker.internal:11434/v1" : "";
}

function usesApiUrl(provider: AssistantModelProvider): boolean {
  return (
    provider === "openai" ||
    provider === "anthropic" ||
    provider === "google" ||
    provider === "ollama"
  );
}

function validate(
  form: ModelForm,
  current?: AssistantHealth,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!form.model.trim()) errors.model = "请填写模型 ID";
  const keepsCurrentToken =
    current?.configured && current.provider === form.provider;
  if (
    form.provider !== "ollama" &&
    !form.apiToken.trim() &&
    !keepsCurrentToken
  ) {
    errors.apiToken = "请填写 API Key";
  }
  if (form.provider === "ollama" && !form.apiUrl.trim())
    errors.apiUrl = "请填写 Ollama API 地址";
  if (form.provider.startsWith("cloudflare-") && !form.accountId.trim()) {
    errors.accountId = "请填写 Account ID";
  }
  if (form.provider === "cloudflare-ai-gateway" && !form.gatewayId.trim()) {
    errors.gatewayId = "请填写 Gateway ID";
  }
  return errors;
}
