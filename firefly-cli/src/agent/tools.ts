import type { AgentTool } from '@earendil-works/pi-agent-core';

import {
  listCapabilities,
  validateCapabilityInput,
  type FfcCapability,
} from '../capabilities/registry.js';
import type { FireflyHttpClient } from '../core/http-client.js';
import type { AiStore } from './store.js';

export function createAgentTools(args: {
  client: FireflyHttpClient;
  store: AiStore;
  sessionId: string;
  ownerKey: string;
}): AgentTool[] {
  return listCapabilities().map((capability) => capabilityTool(capability, args));
}

function capabilityTool(
  capability: FfcCapability,
  context: {
    client: FireflyHttpClient;
    store: AiStore;
    sessionId: string;
    ownerKey: string;
  },
): AgentTool {
  return {
    name: capability.name,
    label: capability.label,
    description: `${capability.description} Risk: ${capability.risk}.`,
    parameters: capability.parameters,
    executionMode: capability.risk === 'read' ? 'parallel' : 'sequential',
    execute: async (_toolCallId, rawInput) => {
      validateCapabilityInput(capability, rawInput);

      if (capability.risk === 'confirm') {
        const preview = capability.preview
          ? await capability.preview(context.client, rawInput)
          : undefined;
        const approval = await context.store.createApproval({
          sessionId: context.sessionId,
          ownerKey: context.ownerKey,
          capability: capability.name,
          input: rawInput,
          preview,
        });
        const result = {
          status: 'approval_required',
          message:
            capability.name === 'submit_bill_secret'
              ? '等待用户在受信界面输入账单密码。'
              : '干跑已完成，等待用户确认后正式导入。',
          approval_id: approval.id,
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          details: { capability: capability.name, risk: capability.risk, approval },
        };
      }

      const result = await capability.execute(context.client, rawInput);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        details: { capability: capability.name, risk: capability.risk },
      };
    },
  } as AgentTool;
}
