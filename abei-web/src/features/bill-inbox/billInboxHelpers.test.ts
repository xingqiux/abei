import { describe, expect, it } from 'vitest'
import type { BillQueueRow, BillTask } from '../../api/schemas'
import {
  attentionKindOf,
  channelDisplayName,
  dismissReasonLabel,
  earliestMonthLabel,
  fundingAccount,
  groupAttentionRows,
  groupRowsByDay,
  isAiSuggested,
  isInboxView,
  isRowSelectable,
  mailStateBadge,
  needsAutofill,
  relativeDayLabel,
  rowMerchant,
  rowPlatform,
  syncResultFeedback,
  workloadOf,
} from './billInboxHelpers'

function makeRow(overrides: Record<string, unknown> = {}): BillQueueRow {
  return {
    id: '1',
    attributes: {
      bill_task_id: '7',
      status: 'pending',
      duplicate_state: 'unique',
      occurred_at: '2026-07-20T10:00:00+08:00',
      amount: '12.34',
      firefly_type: 'withdrawal',
      firefly_date: null,
      firefly_amount: '12.34',
      firefly_description: 'Lunch',
      source_name: 'Checking',
      destination_name: 'Restaurant',
      ...overrides,
    },
  } as BillQueueRow
}

describe('isRowSelectable', () => {
  it('accepts a complete pending unique row and its original-date fallback', () => {
    expect(isRowSelectable(makeRow())).toBe(true)
  })

  it.each([
    ['non-pending status', { status: 'imported' }],
    ['dismissed row', { status: 'dismissed' }],
    ['non-unique row', { duplicate_state: 'duplicate' }],
    ['missing type', { firefly_type: null }],
    ['missing date', { firefly_date: null, occurred_at: null }],
    ['invalid date', { firefly_date: '0' }],
    ['nonexistent calendar date', { firefly_date: '2026-02-31' }],
    ['missing import amount', { firefly_amount: null }],
    ['zero import amount', { firefly_amount: '0' }],
    ['missing description', { firefly_description: null, description: null, counterparty: null }],
    ['missing source', { source_name: ' ' }],
    ['missing destination', { destination_name: null }],
  ])('rejects %s', (_label, overrides) => {
    expect(isRowSelectable(makeRow(overrides))).toBe(false)
  })
})

describe('syncResultFeedback', () => {
  const base = {
    scanned: 0,
    created: 0,
    ignored: 0,
    duplicates: 0,
    failed: 0,
    processed: 0,
    process_failed: 0,
  }

  it('shows a mailbox error instead of a success message', () => {
    expect(syncResultFeedback({ ...base, failed: 1, errors: ['邮箱密码无法解密'] })).toEqual({
      kind: 'error',
      message: '邮箱密码无法解密',
    })
  })

  it('explains a successful sync with no matching mail', () => {
    expect(syncResultFeedback(base)).toEqual({
      kind: 'success',
      message: '同步完成：未发现新的账单邮件',
    })
  })
})

describe('isInboxView', () => {
  it('只认待入账 / 待确认 / 已忽略 / 已入账四个 tab', () => {
    expect(isInboxView('importable')).toBe(true)
    expect(isInboxView('attention')).toBe(true)
    expect(isInboxView('dismissed')).toBe(true)
    expect(isInboxView('imported')).toBe(true)
    expect(isInboxView('parsed')).toBe(false)
    expect(isInboxView(null)).toBe(false)
  })
})

describe('channelDisplayName', () => {
  it('渠道名去掉「交易流水」后缀，空名退回内置中文名', () => {
    expect(channelDisplayName('alipay', '支付宝交易流水')).toBe('支付宝')
    expect(channelDisplayName('boc', '中国银行交易流水明细')).toBe('中国银行')
    expect(channelDisplayName('cmb', '招商银行信用卡每日消费')).toBe('招商银行信用卡每日消费')
    expect(channelDisplayName('wechat', null)).toBe('微信支付')
    expect(channelDisplayName('wechat', '微信支付账单流水')).toBe('微信支付')
    expect(channelDisplayName('unknown', '')).toBe('unknown')
  })
})

describe('dismissReasonLabel', () => {
  it('把后端的忽略原因翻成人话，认不出的原样透出', () => {
    expect(dismissReasonLabel('duplicate_auto')).toBe('判定重复')
    expect(dismissReasonLabel('task_archived')).toBe('整封邮件被忽略')
    expect(dismissReasonLabel(null)).toBe('手动忽略')
    expect(dismissReasonLabel('something_new')).toBe('something_new')
  })
})

describe('mailStateBadge', () => {
  function makeTask(overrides: Record<string, unknown> = {}): BillTask {
    return {
      id: '7',
      attributes: {
        source: 'alipay',
        status: 'parsed',
        row_counts: { total: 0, pending: 0, imported: 0, duplicate: 0, conflict: 0 },
        ...overrides,
      },
    } as BillTask
  }

  it('先说要动手的，再说解析出多少，最后才是没事了', () => {
    expect(mailStateBadge(makeTask({ status: 'needs_secret' })).label).toBe('待解锁')
    expect(mailStateBadge(makeTask({ status: 'failed' })).label).toBe('解析失败')
    expect(mailStateBadge(makeTask({
      row_counts: { total: 9, pending: 3, imported: 6, duplicate: 0, conflict: 0 },
    })).label).toBe('解析出 3 笔')
    expect(mailStateBadge(makeTask({
      row_counts: { total: 9, pending: 0, imported: 9, duplicate: 0, conflict: 0 },
    })).label).toBe('已入账完')
  })

  it('待解锁压过行数：密码没给之前那些行根本不算数', () => {
    expect(mailStateBadge(makeTask({
      status: 'needs_secret',
      row_counts: { total: 4, pending: 4, imported: 0, duplicate: 0, conflict: 0 },
    })).label).toBe('待解锁')
  })
})

describe('attentionKindOf', () => {
  it('状态和判重字段优先于 reason 文案', () => {
    expect(attentionKindOf(makeRow({ status: 'needs_split' }))).toBe('split')
    expect(attentionKindOf(makeRow({ duplicate_state: 'conflict' }))).toBe('conflict')
  })

  it('按 reason 关键词归类，改了措辞也不会整节掉进「其他」', () => {
    expect(attentionKindOf(makeRow({ reasons: ['疑似账户间转账'] }))).toBe('transfer')
    expect(attentionKindOf(makeRow({ reasons: ['跨来源疑似重复（中置信）'] }))).toBe('duplicate')
    expect(attentionKindOf(makeRow({ reasons: ['需要补一句备注'] }))).toBe('note')
    expect(attentionKindOf(makeRow({ reasons: ['说不清'] }))).toBe('other')
  })

  it('分小节时空的小节不出现，顺序固定', () => {
    const sections = groupAttentionRows([
      makeRow({ reasons: ['需要补备注'] }),
      makeRow({ reasons: ['疑似转账'] }),
      makeRow({ reasons: ['疑似转账'] }),
    ])
    expect(sections.map((section) => [section.kind, section.rows.length])).toEqual([
      ['transfer', 2],
      ['note', 1],
    ])
  })
})

describe('AI 建议标记', () => {
  it('人改过之后不再算 AI 填的', () => {
    expect(isAiSuggested(makeRow({ suggested_by: 'ai' }))).toBe(true)
    expect(isAiSuggested(makeRow({ suggested_by: 'ai', user_modified_at: '2026-08-01T00:00:00+08:00' }))).toBe(false)
    expect(isAiSuggested(makeRow())).toBe(false)
  })

  it('只有既没被 AI 碰过也没被人改过、且字段有空的 pending 行才需要补跑', () => {
    expect(needsAutofill(makeRow({ category_name: null }))).toBe(true)
    expect(needsAutofill(makeRow({ suggested_by: 'ai', category_name: null }))).toBe(false)
    expect(needsAutofill(makeRow({ status: 'imported', category_name: null }))).toBe(false)
    expect(needsAutofill(makeRow({ category_name: '餐饮', notes: '午饭' }))).toBe(false)
  })
})

describe('earliestMonthLabel', () => {
  it('给出队列里最早那笔落在哪个月', () => {
    expect(earliestMonthLabel([
      makeRow({ occurred_at: '2026-08-02T10:00:00+08:00' }),
      makeRow({ occurred_at: '2026-06-11T10:00:00+08:00' }),
    ])).toBe('6 月')
    expect(earliestMonthLabel([])).toBeNull()
  })
})

describe('rowPlatform', () => {
  it('描述里的平台前缀优先：招行账单解析出的支付宝消费挂支付宝', () => {
    expect(rowPlatform(makeRow({
      firefly_description: '支付宝-上海盒马网络科技有限公司',
      source_name: '招商银行信用卡(5599)',
      task: { id: '7', source: 'cmb' },
    }).attributes)).toBe('alipay')
  })

  it('花呗比支付宝更具体，先认花呗', () => {
    expect(rowPlatform(makeRow({ firefly_description: '支付宝-花呗还款' }).attributes)).toBe('huabei')
    expect(rowPlatform(makeRow({
      firefly_description: '上海地铁',
      source_name: '花呗',
      task: { id: '7', source: 'alipay' },
    }).attributes)).toBe('huabei')
  })

  it('描述认不出来才退回这封邮件的渠道', () => {
    expect(rowPlatform(makeRow({
      firefly_description: '瑞幸咖啡',
      source_name: '招商银行信用卡(5599)',
      task: { id: '7', source: 'cmb' },
    }).attributes)).toBe('cmb')
  })

  it('账户里的银行名不参与判断：不然招行账单整箱都变成招行标', () => {
    expect(rowPlatform(makeRow({
      firefly_description: '瑞幸咖啡',
      source_name: '招商银行信用卡(5599)',
      task: null,
    }).attributes)).toBe('other')
  })

  it('连渠道都没有就兜底 other', () => {
    expect(rowPlatform(makeRow({ firefly_description: '瑞幸咖啡', source_name: '现金', task: null }).attributes))
      .toBe('other')
  })
})

describe('rowMerchant', () => {
  it('砍掉平台前缀，商户名交给行、平台交给左边那枚标', () => {
    expect(rowMerchant(makeRow({ firefly_description: '支付宝-上海盒马网络科技有限公司' }).attributes))
      .toBe('上海盒马网络科技有限公司')
    expect(rowMerchant(makeRow({ firefly_description: '财付通—瑞幸咖啡' }).attributes)).toBe('瑞幸咖啡')
  })

  it('不是平台前缀的短横线不动', () => {
    expect(rowMerchant(makeRow({ firefly_description: '7-11 便利店' }).attributes)).toBe('7-11 便利店')
  })

  it('砍完剩空的就退回原文，宁可重复也不能把整行说没了', () => {
    expect(rowMerchant(makeRow({ firefly_description: '支付宝-' }).attributes)).toBe('支付宝-')
  })
})

describe('fundingAccount', () => {
  it('支出看钱从哪儿出，收入看钱进了哪儿', () => {
    expect(fundingAccount(makeRow({ direction: '支出' }).attributes)).toBe('Checking')
    expect(fundingAccount(makeRow({ direction: '收入' }).attributes)).toBe('Restaurant')
  })
})

describe('groupRowsByDay', () => {
  it('按天分组、保持原顺序，并算出当日合计', () => {
    const groups = groupRowsByDay([
      makeRow({ firefly_date: '2026-08-08', direction: '支出', firefly_amount: '10.00' }),
      makeRow({ firefly_date: '2026-08-08', direction: '支出', firefly_amount: '5.50' }),
      makeRow({ firefly_date: '2026-08-07', direction: '收入', firefly_amount: '100.00' }),
    ])
    expect(groups.map((group) => group.day)).toEqual(['2026-08-08', '2026-08-07'])
    expect(groups[0].rows).toHaveLength(2)
    expect(groups[0].net).toBeCloseTo(-15.5)
    expect(groups[1].net).toBeCloseTo(100)
  })

  it('转账不计入当日合计：它两头都在自己账上', () => {
    const [group] = groupRowsByDay([
      makeRow({ firefly_date: '2026-08-08', direction: '转账', firefly_amount: '999.00' }),
    ])
    expect(group.net).toBe(0)
  })
})

describe('workloadOf', () => {
  it('支出收入分开算，另给最早一笔的日期', () => {
    const workload = workloadOf([
      makeRow({ firefly_date: '2026-08-08', direction: '支出', firefly_amount: '30.00' }),
      makeRow({ firefly_date: '2026-05-14', direction: '收入', firefly_amount: '18600.00' }),
    ])
    expect(workload).toEqual({ count: 2, expense: 30, income: 18600, earliestDay: '2026-05-14' })
  })
})

describe('relativeDayLabel', () => {
  it('今天 / 昨天 / N 天前', () => {
    expect(relativeDayLabel('2026-08-09', '2026-08-09')).toBe('今天')
    expect(relativeDayLabel('2026-08-08', '2026-08-09')).toBe('昨天')
    expect(relativeDayLabel('2026-05-14', '2026-08-09')).toBe('87 天前')
  })

  it('日期不成形或在未来就不说话', () => {
    expect(relativeDayLabel('--', '2026-08-09')).toBeNull()
    expect(relativeDayLabel('2026-08-10', '2026-08-09')).toBeNull()
  })
})
