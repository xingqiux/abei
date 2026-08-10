/**
 * 写闸门。abei-api 把「会不会真的动数据」这件事收在服务端一处：
 * 参数走请求体，闸门走查询串。
 *
 * - `risk=read`：不设闸。
 * - `risk=draft`（写的是建议、草稿、重跑）：服务端直接放行。
 * - `risk=confirm`（会真的动钱或提交密码）：既不带 `confirm=true` 也不带 `dry_run=true`
 *   就是 409，reason `ConfirmationRequired`。
 *
 * 页面不要试图绕过它：confirm 档的动作必须先干跑拿预览给人看，人点了确认再带 confirm。
 * 两个都给时服务端以 dry_run 优先——先看再改，永远走安全的那一侧。
 */
import { z } from 'zod'

import type { QueryParams } from './client'

export type WriteGate = { readonly dryRun: true } | { readonly confirm: true }

/** 只预览，不落库。 */
export const DRY_RUN: WriteGate = { dryRun: true }

/** 人已经看过预览并确认。 */
export const CONFIRMED: WriteGate = { confirm: true }

export function gateParams(gate: WriteGate): QueryParams {
  return 'dryRun' in gate ? { dry_run: true } : { confirm: true }
}

export function isPreview(gate: WriteGate): boolean {
  return 'dryRun' in gate
}

/**
 * 干跑响应。服务端一律打上 `dry_run: true`——一份「还没发生的事」看起来跟
 * 「已经发生的事」一模一样是要出事的，所以页面必须靠这个标记来决定文案。
 *
 * `bills.import` 的干跑是上游真实预览（整份导入结果的形状，额外多这个标记）；
 * `bills.ignore` / `bills.unlock` / `rows.update` 等的干跑只回一个 `would` 描述，
 * 说明「将要发生什么」，没有更细的内容。
 */
export const dryRunPreviewSchema = z
  .object({
    dry_run: z.literal(true),
    would: z.record(z.string(), z.unknown()).optional(),
    message: z.string().optional(),
  })
  .passthrough()

export type DryRunPreview = z.infer<typeof dryRunPreviewSchema>

export function isDryRunPreview(value: unknown): value is DryRunPreview {
  return dryRunPreviewSchema.safeParse(value).success
}
