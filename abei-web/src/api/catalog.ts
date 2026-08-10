/**
 * 能力目录：`GET /v1/catalog`。
 *
 * 目录是唯一真源。abei-core 里加一条能力，CLI 命令、agent 工具、网页端的标签与审批文案
 * 同时长出来——网页端**不许再养第二份**手写标签表，那种副本只会在服务端改了字之后
 * 悄悄说旧话。
 */
import { z } from 'zod'

import { apiGet } from './client'

export const capabilityRiskSchema = z.enum(['read', 'draft', 'confirm'])
export type CapabilityRisk = z.infer<typeof capabilityRiskSchema>

export const capabilitySchema = z
  .object({
    /** `<资源>.<动词>`，例如 bills.import。 */
    id: z.string(),
    resource: z.string(),
    verb: z.string(),
    risk: capabilityRiskSchema,
    label: z.string(),
    description: z.string(),
    method: z.string(),
    path: z.string(),
    /** agent 的工具名，例如 bills_import。 */
    tool_name: z.string(),
    /** 参数的 JSON Schema，`$ref` 已在服务端摊平。 */
    params: z
      .object({ properties: z.record(z.string(), z.unknown()).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough()

export type Capability = z.infer<typeof capabilitySchema>

/**
 * 这条能力要不要人当场敲一个密码。
 *
 * 判据取自参数模式而不是能力名：目录里加第二条要密码的能力时，页面自动跟上，
 * 不用再回来补一个 `id === '...'` 的分支。
 */
export function needsSecretInput(capability: Capability | undefined): boolean {
  return capability?.params?.properties?.secret !== undefined
}

export const catalogSchema = z
  .object({
    version: z.string().optional(),
    resources: z.array(z.unknown()).optional(),
    capabilities: z.array(capabilitySchema),
  })
  .passthrough()

export type Catalog = z.infer<typeof catalogSchema>

export async function getCatalog(): Promise<Catalog> {
  return catalogSchema.parse(await apiGet('/v1/catalog'))
}

/**
 * 按能力 id 或 agent 工具名建索引。
 *
 * 两种键都收：聊天流里报的是工具名（`bills_import`），审批记录和错误体里报的是
 * id（`bills.import`）。同一条能力两种叫法，别让调用方去猜自己拿到的是哪种。
 */
export function indexCapabilities(catalog: Catalog): Map<string, Capability> {
  const index = new Map<string, Capability>()
  for (const capability of catalog.capabilities) {
    index.set(capability.id, capability)
    index.set(capability.tool_name, capability)
  }
  return index
}
