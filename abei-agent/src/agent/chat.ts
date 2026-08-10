/**
 * 聊天流：把一轮对话跑成 NDJSON 事件流写回页面。
 *
 * 事件表（页面按 type 分支渲染）：
 * meta / text_delta / tool_start / tool_end / approval / done / error。
 * 直接写 node 的 ServerResponse，不经过任何缓冲层——首字延迟和背压都要真实。
 */

import type { ServerResponse } from 'node:http';

import { Agent, type AgentMessage } from '@earendil-works/pi-agent-core';

import type { AbeiApi, Catalog } from './abei-api.js';
import { HttpError, publicErrorMessage } from './http-error.js';
import type { ModelRuntime } from './model-runtime.js';
import { record } from './shared.js';
import type { AiApproval, AiStore } from './store.js';
import { createAgentTools } from './tools.js';

const SYSTEM_PROMPT = `你是阿贝的财务助手。你只处理当前用户的账本、账单收件箱和消费分析。

规则：
- 涉及真实数据时使用工具，不要猜数字、任务状态、分类或账户。
- 服务端已经判定为 duplicate、conflict 或 high-confidence crossSource 的行不要复核或修改。
- rows_update 和 rows_split 只修改待入账草稿；AI 改动会标为待确认建议。
- 风险档为 confirm 的工具（例如 bills_import、bills_ignore）会先干跑，正式执行只能等用户在界面上确认。
- bills_unlock 只是请求用户在受信界面输入密码；不要向用户索要密码文本，也不要让密码进入对话。
- 只用工具列表里有的能力，不声称自己能执行 shell、删除、用户管理、配置或邮箱管理。
- 默认用简洁中文回答，清楚说明你查了什么、改了什么、还在等什么。`;

export async function streamChat(args: {
  response: ServerResponse;
  body: Record<string, unknown>;
  abei: AbeiApi;
  token: string;
  ownerKey: string;
  store: AiStore;
  runtime: ModelRuntime;
  activeSessions: Set<string>;
}): Promise<void> {
  const { response, body, abei, token, ownerKey, store, runtime, activeSessions } = args;
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message || message.length > 8_000) {
    throw new HttpError(422, '消息不能为空，且不能超过 8000 个字符。');
  }
  if (!runtime.model || runtime.error) throw new HttpError(503, runtime.error ?? '模型不可用。');
  if (!(await runtime.models.checkAuth(runtime.provider))) {
    throw new HttpError(503, `尚未配置 ${runtime.provider} 的模型凭证。`);
  }

  if (
    body.session_id !== undefined &&
    (typeof body.session_id !== 'string' || !isUuid(body.session_id))
  ) {
    throw new HttpError(422, 'session_id 格式不正确。');
  }
  let session =
    typeof body.session_id === 'string'
      ? await store.getSession(body.session_id, ownerKey)
      : undefined;
  if (body.session_id !== undefined && !session) throw new HttpError(404, '会话不存在。');
  session ??= await store.createSession({
    ownerKey,
    title: sessionTitle(message),
    provider: runtime.provider,
    model: runtime.modelId,
  });

  // ponytail: 单实例进程锁；需要横向扩容时换 PostgreSQL advisory lock。
  if (activeSessions.has(session.id)) throw new HttpError(409, '这个会话正在生成回复。');
  activeSessions.add(session.id);

  response.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event: Record<string, unknown>) => {
    if (!response.destroyed) response.write(`${JSON.stringify(event)}\n`);
  };
  send({
    type: 'meta',
    session_id: session.id,
    provider: runtime.provider,
    model: runtime.modelId,
  });

  try {
    const [messages, approvals, catalog, tools] = await Promise.all([
      store.loadMessages(session.id, ownerKey),
      store.listApprovals(session.id, ownerKey),
      abei.catalog(token),
      createAgentTools({ abei, token, store, sessionId: session.id, ownerKey }),
    ]);
    const agent = new Agent({
      initialState: {
        systemPrompt: systemPromptWithApprovals(approvals, catalog),
        model: runtime.model,
        thinkingLevel: 'low',
        tools,
        messages,
      },
      streamFn: runtime.models.streamSimple.bind(runtime.models),
      sessionId: session.id,
      toolExecution: 'sequential',
    });
    response.once('close', () => {
      if (!response.writableEnded) agent.abort();
    });
    agent.subscribe((event) => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        send({ type: 'text_delta', delta: event.assistantMessageEvent.delta });
      } else if (event.type === 'tool_execution_start') {
        const capability = catalog.byToolName(event.toolName);
        send({
          type: 'tool_start',
          tool_call_id: event.toolCallId,
          capability: capability?.id ?? event.toolName,
          label: capability?.label,
          input: event.args,
        });
      } else if (event.type === 'tool_execution_end') {
        const details = toolDetails(event.result);
        const capability = catalog.byToolName(event.toolName);
        send({
          type: 'tool_end',
          tool_call_id: event.toolCallId,
          capability: capability?.id ?? event.toolName,
          label: capability?.label,
          error: event.isError,
        });
        if (details?.approval) send({ type: 'approval', approval: details.approval });
      }
    });

    await agent.prompt(message);
    if (agent.state.errorMessage) {
      throw new HttpError(502, modelFailureMessage(agent.state.errorMessage));
    }
    const appended = agent.state.messages.slice(messages.length);
    await store.appendMessages(session.id, ownerKey, messages.length, appended);
    send({ type: 'done', session_id: session.id });
  } catch (error) {
    send({ type: 'error', message: publicErrorMessage(error) });
  } finally {
    activeSessions.delete(session.id);
    response.end();
  }
}

/** 模型报错一律换成同一句话：上游消息里可能带凭证或内部地址。 */
export function modelFailureMessage(providerMessage: string): string {
  void providerMessage;
  return '模型请求失败，请检查模型凭证和服务地址。';
}

/** 页面渲染历史消息用的形状：只留用户和助手的文字。 */
export function displayMessages(messages: AgentMessage[]): Array<Record<string, unknown>> {
  return messages.flatMap((message, index) => {
    if (!('role' in message) || (message.role !== 'user' && message.role !== 'assistant'))
      return [];
    const content = messageContent(message.content);
    if (!content && message.role === 'assistant') return [];
    return [
      {
        id: String(index),
        role: message.role,
        content,
        timestamp: 'timestamp' in message ? message.timestamp : undefined,
      },
    ];
  });
}

function messageContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((block) => (record(block)?.type === 'text' ? [String(record(block)?.text ?? '')] : []))
    .join('');
}

function systemPromptWithApprovals(approvals: AiApproval[], catalog: Catalog): string {
  const timeZone = process.env.TZ || 'Asia/Shanghai';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
  const prompt = `${SYSTEM_PROMPT}\n\n当前日期：${today}（${timeZone}）。能力目录版本 ${catalog.version}。`;
  if (approvals.length === 0) return prompt;
  const status = approvals
    .slice(-20)
    .map((approval) => `${approval.capability} ${approval.id}: ${approval.status}`)
    .join('\n');
  return `${prompt}\n\n当前会话最近的人工审批状态：\n${status}`;
}

function toolDetails(result: unknown): { approval?: AiApproval } | undefined {
  const details = record(record(result)?.details);
  return details as { approval?: AiApproval } | undefined;
}

function sessionTitle(message: string): string {
  return message.replace(/\s+/g, ' ').slice(0, 60);
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
