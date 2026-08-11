import type { AgentTool } from '@earendil-works/pi-agent-core';

import { AbeiProblemError, type AbeiApi, type AbeiCapability, type Catalog } from './abei-api.js';
import type { AiApproval, AiStore } from './store.js';

export interface AgentToolContext {
  abei: AbeiApi;
  /** 调用方的 Firefly 个人访问令牌，原样透传给 abei-api。 */
  token: string;
  store: AiStore;
  sessionId: string;
  ownerKey: string;
}

/** 从能力目录现取工具定义。目录加一条能力，模型这边就多一个工具，不必改代码。 */
export async function createAgentTools(context: AgentToolContext): Promise<AgentTool[]> {
  const catalog = await context.abei.catalog(context.token);
  return catalog.list().map((capability) => capabilityTool(capability, context));
}

/**
 * 这条能力里有哪些参数得由人来填。
 *
 * 目录里就标着（参数模式上的 `x-abei-human-only`），agent 这边不另存一份名单——
 * 存了就会和目录漂移，而漂移的方向恰好是「密码被当成普通字段交给模型」。
 */
export function humanOnlyParams(capability: { human_only?: string[] }): string[] {
  return capability.human_only ?? [];
}

/**
 * 模型看到的参数模式：摘掉人填字段，去掉 `$schema` 和 `title` 这类对模型没用的键。
 */
export function modelParameters(capability: AbeiCapability): Record<string, unknown> {
  const rest = Object.fromEntries(
    Object.entries(capability.params).filter(([key]) => key !== '$schema' && key !== 'title'),
  );
  const hidden = [...humanOnlyParams(capability), ...Object.keys(capability.fixed_params ?? {})];
  if (hidden.length === 0) return rest;

  const properties = { ...schemaProperties(capability.params) };
  for (const key of hidden) delete properties[key];
  const required = Array.isArray(rest.required)
    ? (rest.required as string[]).filter((key) => !hidden.includes(key))
    : undefined;
  return { ...rest, properties, ...(required ? { required } : {}) };
}

function capabilityTool(capability: AbeiCapability, context: AgentToolContext): AgentTool {
  const pending = humanOnlyParams(capability);
  return {
    name: capability.tool_name,
    label: capability.label,
    description: `${capability.description}（风险档 ${capability.risk}）`,
    parameters: modelParameters(capability),
    executionMode: capability.risk === 'read' ? 'parallel' : 'sequential',
    execute: async (_toolCallId, rawInput) => {
      const input = sanitize(rawInput, pending);

      if (capability.risk === 'confirm') {
        return waitForHuman({ capability, context, input, pending });
      }

      try {
        const result = await context.abei.invoke({
          token: context.token,
          capability,
          params: input,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          details: { capability: capability.id, risk: capability.risk },
        };
      } catch (error) {
        // 目录说是 draft、服务端判成 confirm，说明本地目录过期了。
        // 这不是错误，按「等人确认」走同一条路。
        if (error instanceof AbeiProblemError && error.needsConfirmation) {
          return waitForHuman({ capability, context, input, pending });
        }
        throw error;
      }
    },
  } as AgentTool;
}

/**
 * 写闸门在页面这一侧的落点：先干跑拿预览，落一条待确认的审批，然后停下等人。
 * 模型拿不到 confirm——正式执行只能由人在页面上点。
 */
async function waitForHuman(args: {
  capability: AbeiCapability;
  context: AgentToolContext;
  input: Record<string, unknown>;
  pending: string[];
}) {
  const { capability, context, input, pending } = args;
  // 缺人填的参数就跑不了干跑（比如账单密码，abei-api 校验时就要求它非空），
  // 这时直接落审批，预览留空。
  const preview =
    pending.length > 0
      ? undefined
      : await context.abei.invoke({
          token: context.token,
          capability,
          params: input,
          gate: { dryRun: true },
        });

  const approval = await context.store.createApproval({
    sessionId: context.sessionId,
    ownerKey: context.ownerKey,
    capability: capability.id,
    input,
    preview,
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          status: 'approval_required',
          approval_id: approval.id,
          message:
            pending.length > 0
              ? `等用户在受信界面填写${pending.join('、')}并确认。不要向用户索要，也不要自己编。`
              : '干跑已完成，等用户在页面上确认后才会真正执行。',
        }),
      },
    ],
    details: {
      capability: capability.id,
      risk: capability.risk,
      approval: describeApproval(approval, capability, pending),
    },
  };
}

/**
 * 审批发给页面时补上目录里的中文标签和「还缺人填哪几项」，
 * 页面不必再按能力名硬编码文案和输入框。
 */
export function describeApproval(
  approval: AiApproval,
  capability: AbeiCapability | undefined,
  pending?: string[],
): AiApproval & { label?: string; risk?: string; needs_user_input: string[] } {
  return {
    ...approval,
    label: capability?.label,
    risk: capability?.risk,
    needs_user_input: pending ?? (capability ? humanOnlyParams(capability) : []),
  };
}

/** 目录里带标签的审批列表，页面渲染历史审批卡用。 */
export function describeApprovals(approvals: AiApproval[], catalog: Catalog) {
  return approvals.map((approval) => describeApproval(approval, catalog.byId(approval.capability)));
}

/** 模型送来的参数：只留对象，且人填字段一律丢掉，不给它绕过受信界面的机会。 */
function sanitize(rawInput: unknown, humanOnly: string[]): Record<string, unknown> {
  const input =
    rawInput !== null && typeof rawInput === 'object' && !Array.isArray(rawInput)
      ? { ...(rawInput as Record<string, unknown>) }
      : {};
  for (const key of humanOnly) delete input[key];
  return input;
}

function schemaProperties(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema.properties;
  return properties !== null && typeof properties === 'object'
    ? (properties as Record<string, unknown>)
    : {};
}
