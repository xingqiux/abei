import { describe, expect, it } from 'vitest'
import type { BillQueueRow, BillTask } from '../../api/schemas'
import {
  activeInboxView,
  attentionKindOf,
  buildPairEntries,
  channelDisplayName,
  currencyPrefix,
  directionLabel,
  dismissReasonLabel,
  earliestMonthLabel,
  fundingAccount,
  groupAttentionRows,
  groupRowsByDay,
  groupRowsByImportBatch,
  pairScopeOf,
  isAiSuggested,
  isAutoMerged,
  isInboxView,
  isMergedRow,
  doneViewOf,
  inboxTabOf,
  isRowSelectable,
  mailStateBadge,
  narrowMetaLine,
  needsAutofill,
  normalizeInboxSearch,
  relativeDayLabel,
  relativeTimeLabel,
  rowMerchant,
  rowPlatform,
  sumByCurrency,
  syncResultFeedback,
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

  it('账户没对上不再拦着勾选：服务端入账那一刻会替人把账户建好', () => {
    expect(isRowSelectable(makeRow({ issues: [{ code: 'account_mapping_required' }] }))).toBe(true)
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
      message: '检查完成：没有新邮件',
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

  it('服务端把 name 写成 key 时退回内置中文名，而不是把 cmb 印在 chip 上', () => {
    expect(channelDisplayName('cmb', 'cmb')).toBe('招商银行')
    expect(channelDisplayName('alipay', 'alipay')).toBe('支付宝')
    expect(channelDisplayName('brand_new', 'brand_new')).toBe('brand_new')
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
  it('服务端下发的 attention_kind 说了算', () => {
    expect(attentionKindOf(makeRow({ attention_kind: 'account_unmapped' }))).toBe('account_unmapped')
    expect(attentionKindOf(makeRow({ attention_kind: 'pairing_suggested' }))).toBe('pairing_suggested')
    // 认不出的值不能整片掉进 undefined，退回结构化判断
    expect(attentionKindOf(makeRow({ attention_kind: 'brand_new_kind' }))).toBe('needs_fix')
  })

  it('服务端没下发时按 issue code 判，不看中文文案', () => {
    expect(attentionKindOf(makeRow({ issues: [{ code: 'pair_suggested' }] }))).toBe('pairing_suggested')
    expect(attentionKindOf(makeRow({ issues: [{ code: 'duplicate_suspect' }] }))).toBe('duplicate_suspect')
    expect(attentionKindOf(makeRow({ issues: [{ code: 'import_failed' }] }))).toBe('import_failed')
  })

  it('没有 issue 时看 import_attempt 和判重状态', () => {
    expect(attentionKindOf(makeRow({ import_attempt: { id: '1', status: 'uncertain' } }))).toBe('import_pending')
    expect(attentionKindOf(makeRow({ import_attempt: { id: '1', status: 'retryable' } }))).toBe('import_failed')
    expect(attentionKindOf(makeRow({ duplicate_state: 'conflict' }))).toBe('duplicate_suspect')
    expect(attentionKindOf(makeRow({ duplicate_state: 'duplicate' }))).toBe('duplicate_suspect')
  })

  it('中文 reason 再也不参与分类：措辞变了不影响分节', () => {
    expect(attentionKindOf(makeRow({ reasons: ['疑似账户间转账'] }))).toBe('needs_fix')
    expect(attentionKindOf(makeRow({ reasons: ['跨来源疑似重复（中置信）'] }))).toBe('needs_fix')
  })

  it('分小节时空的小节不出现，顺序固定', () => {
    const sections = groupAttentionRows([
      makeRow({ issues: [{ code: 'duplicate_suspect' }] }),
      makeRow({ attention_kind: 'account_unmapped' }),
      makeRow({ attention_kind: 'account_unmapped' }),
    ])
    expect(sections.map((section) => [section.kind, section.rows.length])).toEqual([
      ['account_unmapped', 2],
      ['duplicate_suspect', 1],
    ])
    // 每一节都得带上「要你判断什么、判完会怎样」那句话
    expect(sections.every((section) => section.hint.length > 0)).toBe(true)
  })
})

describe('activeInboxView', () => {
  it('哪儿有活落哪儿：待入账优先，否则待确认', () => {
    expect(activeInboxView({ importable: 3, attention: 9 })).toBe('importable')
    expect(activeInboxView({ importable: 0, attention: 9 })).toBe('attention')
    expect(activeInboxView({ importable: 0, attention: 0 })).toBe('importable')
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
      makeRow({ firefly_date: '2026-08-08', direction: '支出', firefly_amount: '10.00', currency_code: 'CNY', currency_symbol: '¥' }),
      makeRow({ firefly_date: '2026-08-08', direction: '支出', firefly_amount: '5.50', currency_code: 'CNY', currency_symbol: '¥' }),
      makeRow({ firefly_date: '2026-08-07', direction: '收入', firefly_amount: '100.00', currency_code: 'CNY', currency_symbol: '¥' }),
    ])
    expect(groups.map((group) => group.day)).toEqual(['2026-08-08', '2026-08-07'])
    expect(groups[0].rows).toHaveLength(2)
    expect(groups[0].totals).toHaveLength(1)
    expect(groups[0].totals[0].net).toBeCloseTo(-15.5)
    expect(groups[1].totals[0].net).toBeCloseTo(100)
  })

  it('转账不计入当日合计：它两头都在自己账上', () => {
    const [group] = groupRowsByDay([
      makeRow({ firefly_date: '2026-08-08', direction: '转账', firefly_amount: '999.00' }),
    ])
    expect(group.totals[0].net).toBe(0)
  })

  it('多币种分开算，绝不把美元和人民币加成一个数', () => {
    const [group] = groupRowsByDay([
      makeRow({ firefly_date: '2026-08-08', direction: '支出', firefly_amount: '68.00', currency_code: 'CNY', currency_symbol: '¥' }),
      makeRow({ firefly_date: '2026-08-08', direction: '支出', firefly_amount: '68.00', currency_code: 'USD', currency_symbol: '$' }),
    ])
    expect(group.totals.map((entry) => [entry.code, entry.net])).toEqual([
      ['CNY', -68],
      ['USD', -68],
    ])
  })
})

describe('sumByCurrency', () => {
  it('同币种进出分开累加', () => {
    expect(sumByCurrency([
      makeRow({ direction: '支出', firefly_amount: '30.00', currency_code: 'CNY', currency_symbol: '¥' }),
      makeRow({ direction: '收入', firefly_amount: '18600.00', currency_code: 'CNY', currency_symbol: '¥' }),
    ])).toEqual([{ code: 'CNY', symbol: '¥', expense: 30, income: 18600, net: 18570 }])
  })
})

describe('currencyPrefix', () => {
  it('只有币种代码时换成符号，认不出的代码前置并留一个空格', () => {
    expect(currencyPrefix({ currency_symbol: null, currency_code: 'CNY' })).toBe('¥')
    expect(currencyPrefix({ currency_symbol: '$', currency_code: 'USD' })).toBe('$')
    expect(currencyPrefix({ currency_symbol: 'CNY', currency_code: 'CNY' })).toBe('¥')
    expect(currencyPrefix({ currency_symbol: null, currency_code: 'XYZ' })).toBe('XYZ ')
  })
})

describe('directionLabel', () => {
  it('原始 out/in 也说人话', () => {
    expect(directionLabel('out')).toBe('支出')
    expect(directionLabel('in')).toBe('收入')
    expect(directionLabel('支出')).toBe('支出')
    expect(directionLabel(null)).toBe('--')
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

describe('narrowMetaLine', () => {
  it('窄屏第二行给出渠道、时间和状态', () => {
    const row = makeRow({ task: { id: '7', source: 'cmb', summary: null, received_at: null } })
    expect(narrowMetaLine(row.attributes, '待确认')).toBe('招商银行 · 10:00 · 待确认')
  })

  it('缺的部分不留空占位', () => {
    expect(narrowMetaLine(makeRow({ occurred_at: null }).attributes)).toBe('')
  })
})

describe('normalizeInboxSearch 两层坐标与旧链接兼容', () => {
  it('裸地址落在待处理层，默认值不写进 search', () => {
    expect(normalizeInboxSearch({})).toEqual({ source: undefined, task: undefined })
    expect(inboxTabOf(normalizeInboxSearch({}))).toBe('pending')
    expect(doneViewOf(normalizeInboxSearch({}))).toBe('imported')
  })

  it('旧 view=importable / attention 折进待处理层，只当定位锚', () => {
    expect(normalizeInboxSearch({ view: 'importable' })).toMatchObject({ section: 'importable' })
    expect(normalizeInboxSearch({ view: 'attention' })).toMatchObject({ section: 'attention' })
    expect(inboxTabOf(normalizeInboxSearch({ view: 'attention' }))).toBe('pending')
  })

  it('旧 view=imported / dismissed 折进已完成层', () => {
    expect(inboxTabOf(normalizeInboxSearch({ view: 'imported' }))).toBe('done')
    expect(doneViewOf(normalizeInboxSearch({ view: 'imported' }))).toBe('imported')
    expect(inboxTabOf(normalizeInboxSearch({ view: 'dismissed' }))).toBe('done')
    expect(doneViewOf(normalizeInboxSearch({ view: 'dismissed' }))).toBe('dismissed')
  })

  it('旧链接上的渠道和邮件过滤原样保留', () => {
    expect(normalizeInboxSearch({ view: 'dismissed', source: 'cmb', task: '12' })).toEqual({
      source: 'cmb', task: '12', tab: 'done', done: 'dismissed',
    })
  })

  it('新参数优先：tab 在场时不再回头认 view', () => {
    expect(inboxTabOf(normalizeInboxSearch({ tab: 'pending', view: 'dismissed' }))).toBe('pending')
    expect(inboxTabOf(normalizeInboxSearch({ tab: 'done', view: 'importable' }))).toBe('done')
  })

  it('认不出来的值一律退回默认，不把垃圾带进页面', () => {
    expect(normalizeInboxSearch({ tab: 'bogus', view: 'bogus', source: '', task: '' })).toEqual({
      source: undefined, task: undefined,
    })
    expect(normalizeInboxSearch({ tab: 'done', done: 'bogus' })).toEqual({
      source: undefined, task: undefined, tab: 'done', done: undefined,
    })
    expect(normalizeInboxSearch({ tab: 'pending', section: 'bogus' })).toMatchObject({ section: undefined })
  })
})

describe('relativeTimeLabel', () => {
  const now = Date.parse('2026-08-14T12:00:00Z')

  it('一分钟以内说刚刚，往上依次到分钟、小时、天', () => {
    expect(relativeTimeLabel('2026-08-14T11:59:30Z', now)).toBe('刚刚')
    expect(relativeTimeLabel('2026-08-14T11:48:00Z', now)).toBe('12 分钟前')
    expect(relativeTimeLabel('2026-08-14T09:00:00Z', now)).toBe('3 小时前')
    expect(relativeTimeLabel('2026-08-12T12:00:00Z', now)).toBe('2 天前')
  })

  it('没同步过、或时间读不出来时不硬凑一句', () => {
    expect(relativeTimeLabel(null, now)).toBeNull()
    expect(relativeTimeLabel('不是时间', now)).toBeNull()
  })
})

describe('buildPairEntries', () => {
  function paired(id: string, linkId: string, other: string, state = 'suggested') {
    return { ...makeRow({ pair: { link_id: linkId, state, other: { id: other } } }), id } as BillQueueRow
  }

  it('两条挂同一条 link 的行折成一条 pair，只出现一次', () => {
    const entries = buildPairEntries([paired('1', 'L1', '2'), paired('2', 'L1', '1')])
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe('pair')
    if (entries[0].kind === 'pair') {
      expect(entries[0].left.id).toBe('1')
      expect(entries[0].right.id).toBe('2')
    }
  })

  it('对侧不在这一批里就退化成普通行，并标成落单', () => {
    const entries = buildPairEntries([paired('1', 'L1', '99')])
    expect(entries).toEqual([expect.objectContaining({ kind: 'single', orphan: true })])
  })

  it('没有配对的行原样保留，顺序不变', () => {
    const plain = { ...makeRow(), id: '5' } as BillQueueRow
    const entries = buildPairEntries([plain, paired('1', 'L1', '2'), paired('2', 'L1', '1')])
    expect(entries.map((entry) => entry.key)).toEqual(['5', 'pair-L1'])
  })
})

describe('isMergedRow / isAutoMerged', () => {
  it('已确认的配对算合并，系统自己合的还要认得出是自动的', () => {
    const auto = makeRow({ pair: { link_id: 'L1', state: 'confirmed', decided_by: 'auto', other: {} } })
    const byUser = makeRow({ pair: { link_id: 'L2', state: 'confirmed', decided_by: 'user', other: {} } })
    const suggested = makeRow({ pair: { link_id: 'L3', state: 'suggested', other: {} } })
    expect(isMergedRow(auto)).toBe(true)
    expect(isAutoMerged(auto)).toBe(true)
    expect(isMergedRow(byUser)).toBe(true)
    expect(isAutoMerged(byUser)).toBe(false)
    expect(isMergedRow(suggested)).toBe(false)
    expect(isMergedRow(makeRow())).toBe(false)
  })
})

describe('groupRowsByImportBatch', () => {
  function imported(id: string, batchId: string | null, at: string, amount = '-10.00') {
    return {
      ...makeRow({
        status: 'imported',
        direction: '支出',
        amount: amount.replace('-', ''),
        firefly_amount: amount.replace('-', ''),
        import_attempt: { id: `A${id}`, status: 'succeeded', updated_at: at, batch_id: batchId },
      }),
      id,
    } as BillQueueRow
  }

  it('一次入账动作写进去的那几行聚成一组，组头时间取这一批最早的那条', () => {
    const groups = groupRowsByImportBatch([
      imported('1', 'B1', '2026-08-16T09:03:05'),
      imported('2', 'B1', '2026-08-16T09:03:01'),
      imported('3', 'B2', '2026-08-16T10:00:00'),
    ])
    expect(groups.map((group) => group.batchId)).toEqual(['B1', 'B2'])
    expect(groups[0].rows).toHaveLength(2)
    expect(groups[0].at).toBe('2026-08-16T09:03:01')
  })

  it('没有批次编号的行归到最后一组，不跟前面任何一批混在一起', () => {
    const groups = groupRowsByImportBatch([
      imported('1', null, '2026-08-16T09:00:00'),
      imported('2', 'B1', '2026-08-16T09:03:00'),
      imported('3', null, '2026-08-16T11:00:00'),
    ])
    expect(groups.map((group) => group.batchId)).toEqual(['B1', null])
    expect(groups[1].rows.map((row) => row.id)).toEqual(['1', '3'])
  })

  it('合计按币种分开，和日期分组用的是同一份口径', () => {
    const groups = groupRowsByImportBatch([
      imported('1', 'B1', '2026-08-16T09:00:00', '-10.00'),
      imported('2', 'B1', '2026-08-16T09:00:01', '-5.50'),
    ])
    expect(groups[0].totals).toHaveLength(1)
    expect(groups[0].totals[0].net).toBeCloseTo(-15.5)
  })
})

describe('pairScopeOf', () => {
  function sided(id: string, linkId: string, other: string, source: string) {
    return {
      ...makeRow({
        pair: { link_id: linkId, state: 'suggested', other: { id: other } },
        task: { id: '1', source },
      }),
      id,
    } as BillQueueRow
  }

  it('两条来自同一个渠道时报同渠道——「两个渠道各记了一次」在那里是句假话', () => {
    const entries = buildPairEntries([sided('1', 'L1', '2', 'cmb'), sided('2', 'L1', '1', 'cmb')])
    expect(pairScopeOf(entries)).toBe('same')
  })

  it('跨渠道的一对报跨渠道，两种都有时报混合', () => {
    const cross = buildPairEntries([sided('1', 'L1', '2', 'cmb'), sided('2', 'L1', '1', 'alipay')])
    expect(pairScopeOf(cross)).toBe('cross')
    expect(pairScopeOf([...cross, ...buildPairEntries([
      sided('3', 'L2', '4', 'cmb'),
      sided('4', 'L2', '3', 'cmb'),
    ])])).toBe('mixed')
  })
})
