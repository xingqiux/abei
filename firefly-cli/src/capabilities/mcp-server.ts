import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';

import type { FireflyHttpClient } from '../core/http-client.js';
import { getCapability, listCapabilities, validateCapabilityInput } from './registry.js';

export async function runMcpServer(client: FireflyHttpClient): Promise<void> {
  const server = new Server(
    { name: 'ffc', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'Firefly accounting capabilities. Draft edits are marked as AI suggestions. ' +
        'Imports and bill secrets always require a human outside MCP.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: listCapabilities().map((capability) => ({
      name: capability.name,
      title: capability.label,
      description: `[${capability.risk}] ${capability.description}`,
      inputSchema: capability.parameters as never,
      annotations: {
        readOnlyHint: capability.risk === 'read',
        destructiveHint: false,
        idempotentHint: capability.risk === 'read',
        openWorldHint: false,
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    try {
      const capability = getCapability(request.params.name);
      const input = request.params.arguments ?? {};
      validateCapabilityInput(capability, input);

      if (capability.risk === 'confirm') {
        const preview = capability.preview ? await capability.preview(client, input) : undefined;
        return toolResult({
          status: 'approval_required',
          capability: capability.name,
          message:
            capability.name === 'submit_bill_secret'
              ? '请让用户在 Abaku 受信界面或 ffc bill-inbox secret submit 中输入密码。'
              : '干跑已完成。请让用户在 Abaku 中确认正式导入。',
          preview,
        });
      }

      return toolResult(await capability.execute(client, input));
    } catch (error) {
      return {
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  });

  await server.connect(new StdioServerTransport());
}

function toolResult(value: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  };
}
