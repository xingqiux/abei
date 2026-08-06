import { describe, expect, it } from 'vitest'
import liveRecurrences from './__fixtures__/recurrences.live.json'
import { recurrencesResponseSchema } from './schemas'

/**
 * 拿**真实抓下来的** Firefly 响应校验 schema，而不是手写夹具。
 *
 * 起因：`recurrenceAttributesSchema` 曾把交易模板字段写成 `recurrence_transactions`，
 * 而 Firefly 实际返回的是 `transactions`。schema 用 `.passthrough()` 且该字段有默认值，
 * 所以解析不报错，只是永远拿到空数组——订阅列表长期显示「未配置账户模板」和「—」。
 * 单测夹具当时照着错的键名编，于是测试全绿、真实数据是坏的。
 *
 * 手写夹具挡不住这类错，只有真实响应能。夹具由
 * `curl /api/v1/recurrences` 抓取后脱敏（只改标题与账户名，键名与类型原样保留）。
 * Firefly 升级后若这里挂了，先去核对真实响应，别直接改夹具迁就 schema。
 */
describe('schema 对真实 Firefly 响应', () => {
  it('recurrences：能解析，且 UI 依赖的字段都在', () => {
    const parsed = recurrencesResponseSchema.parse(liveRecurrences)

    const first = parsed.data[0]
    expect(first).toBeDefined()

    const attrs = first.attributes
    expect(attrs.title).toBeTruthy()
    expect(attrs.first_date).toBeTruthy()
    expect(attrs.repetitions.length).toBeGreaterThan(0)

    // 订阅行渲染账户流向与金额靠这一组，缺任何一个都会退化成「未配置账户模板」
    const tx = attrs.transactions[0]
    expect(tx, 'attributes.transactions 必须有内容——键名写错时它会是空数组').toBeDefined()
    expect(tx.amount).toBeTruthy()
    expect(tx.currency_symbol).toBeTruthy()
    expect(tx.source_name).toBeTruthy()
    expect(tx.destination_name).toBeTruthy()
  })

  it('schema 没有凭空发明真实响应里不存在的字段', () => {
    // 这条才是真正的守门。上一条测不出键名写错——`.passthrough()` 会把真实的
    // `transactions` 原样透传，所以哪怕 schema 声明的是 `recurrence_transactions`，
    // `parsed.attributes.transactions` 照样有值，断言照样过。
    //
    // 真正的信号在另一头：schema 声明了一个真实响应里没有的键时，解析结果会多出
    // 那个键（带着 `.default()` 给的空值），而原始响应里找不到它。
    // 所以这里比对「解析后多出来的键」，任何被发明出来的字段都会在这里现形。
    const raw = (liveRecurrences as { data: { attributes: Record<string, unknown> }[] }).data[0].attributes
    const parsed = recurrencesResponseSchema.parse(liveRecurrences).data[0].attributes as Record<string, unknown>

    const invented = Object.keys(parsed).filter((key) => !(key in raw))
    expect(invented, `schema 声明了真实响应里没有的字段：${invented.join(', ')}`).toEqual([])
  })
})
