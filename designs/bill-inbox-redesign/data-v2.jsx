/* v2 数据层。
   v1 的教训写进了结构里：这一版的每个数字都从同一份 ROWS2 推导 ——
   管道叙事、两层开关、来源 chip、列表头、批量按钮，加出来永远一致。
   数量对齐真实环境：待处理 172（可入账 136 + 需判断 36）、已入账 320、
   忽略/清理 210（用户 33 + 机器判重 74 + 零元 12 + 随邮件归档 91），共 702 笔；
   邮件 58 封，其中 2 封待解锁、1 封解析失败。 */

const TODAY = '2026-08-09'

/* ── 渠道 = 「账单来源」，语义是"这封账单邮件谁发来的" ──────
   行首的平台标是另一回事（这一笔用什么支付的），两者在 v2 里
   分开命名、分开出现，再也不共用一个数字。 */
const CHANNELS = [
  { key: 'cmb', label: '招商银行', platform: 'cmb', mailTotal: 24 },
  { key: 'wechat', label: '微信支付', platform: 'wechat', mailTotal: 18 },
  { key: 'alipay', label: '支付宝', platform: 'alipay', mailTotal: 8 },
  { key: 'boc', label: '中国银行', platform: 'boc', mailTotal: 8 },
]
const MAIL_TOTAL = CHANNELS.reduce((s, c) => s + c.mailTotal, 0) // 58

/* ── 邮件（近期的逐封列出，更早的按渠道折叠为一句话）──────── */
const MAILS = [
  { id: 'c1', channel: 'cmb', subject: '招商银行信用卡每日消费', at: '08-09', state: 'ok' },
  { id: 'c2', channel: 'cmb', subject: '招商银行信用卡每日消费', at: '08-08', state: 'ok' },
  { id: 'c3', channel: 'cmb', subject: '招商银行交易流水（7 月）', at: '08-02', state: 'ok' },
  { id: 'c4', channel: 'cmb', subject: '招商银行信用卡每日消费', at: '07-28', state: 'done' },
  { id: 'w1', channel: 'wechat', subject: '微信支付账单流水', at: '08-10', state: 'locked' },
  { id: 'w2', channel: 'wechat', subject: '微信支付账单流水', at: '08-03', state: 'done' },
  { id: 'w3', channel: 'wechat', subject: '微信支付账单流水', at: '07-27', state: 'done' },
  { id: 'w4', channel: 'wechat', subject: '微信支付账单流水', at: '07-20', state: 'done' },
  { id: 'a1', channel: 'alipay', subject: '支付宝交易流水明细（加密）', at: '08-02', state: 'locked' },
  { id: 'a2', channel: 'alipay', subject: '支付宝交易流水明细（5 月）', at: '08-06', state: 'ok' },
  { id: 'a3', channel: 'alipay', subject: '支付宝交易流水明细（4 月）', at: '07-08', state: 'done' },
  { id: 'b1', channel: 'boc', subject: '中国银行借记卡对账单', at: '07-28', state: 'ok' },
  { id: 'b2', channel: 'boc', subject: '中国银行借记卡对账单', at: '06-28', state: 'failed' },
]

const MAIL_STATE = {
  ok: { label: '已解析', kind: 'ok' },
  locked: { label: '待解锁', kind: 'warn' },
  failed: { label: '解析失败', kind: 'danger' },
  done: { label: '处理完毕', kind: 'muted' },
}

const CAT_TONE = {
  餐饮美食: 'var(--cat-1)',
  交通出行: 'var(--cat-6)',
  日用百货: 'var(--cat-11)',
  美容美发: 'var(--cat-9)',
  文化休闲: 'var(--cat-3)',
  家居家装: 'var(--cat-11)',
  商业服务: 'var(--cat-12)',
  服饰装扮: 'var(--cat-9)',
  数字订阅: 'var(--cat-3)',
  医疗健康: 'var(--cat-4)',
  信用还款: 'var(--cat-12)',
}

/* ── 手写样例行 ─────────────────────────────────────────────
   row: { id, date, platform(支付方式标), merchant, amount, dir, category,
          ai, account, pay(支付方式原文), mail, state, kind?, to?, dupOf?, dupMails?, reason? } */
function mk(id, date, platform, merchant, amount, dir, category, ai, account, mail, extra) {
  return Object.assign({
    id, date, platform, merchant, amount, dir,
    category: category || null, ai: !!ai, account, mail,
    pay: null, state: 'importable', kind: null,
  }, extra || {})
}

const HAND = [
  // ── 招行 08-09 那封：08-08 当天消费（可直接入账）──────────
  mk('r1', '2026-08-08', 'alipay', '上海盒马网络科技有限公司', '56.10', '支出', '日用百货', true, '招商银行信用卡(5599)', 'c1', { pay: '快捷支付' }),
  mk('r2', '2026-08-08', 'alipay', '上海盒马网络科技有限公司', '71.79', '支出', '日用百货', true, '招商银行信用卡(5599)', 'c1', { pay: '快捷支付' }),
  mk('r3', '2026-08-08', 'tenpay', '暖暖家（七浦路服装批发市场）', '100.00', '支出', '服饰装扮', true, '招商银行信用卡(5599)', 'c1', { pay: '快捷支付' }),
  mk('r4', '2026-08-08', 'alipay', '上海崎本的店面包静安大悦城店', '26.00', '支出', '餐饮美食', true, '招商银行信用卡(5599)', 'c1', { pay: '快捷支付' }),
  mk('r5', '2026-08-08', 'alipay', '上海福满家便利有限公司', '3.00', '支出', '日用百货', true, '招商银行信用卡(5599)', 'c1', { pay: '快捷支付' }),
  mk('r6', '2026-08-08', 'tenpay', '张记油条上海报春路店', '9.00', '支出', '餐饮美食', false, '招商银行信用卡(5599)', 'c1', { pay: '快捷支付' }),
  mk('r7', '2026-08-08', 'tenpay', '张记油条上海报春路店', '8.00', '支出', '餐饮美食', false, '招商银行信用卡(5599)', 'c1', { pay: '快捷支付' }),
  mk('r8', '2026-08-08', 'tenpay', '瑞幸咖啡', '9.90', '支出', '餐饮美食', false, '招商银行信用卡(5599)', 'c1', { pay: '快捷支付' }),
  mk('r9', '2026-08-08', 'alipay', '千里香馄饨报春路', '23.00', '支出', '餐饮美食', false, '招商银行信用卡(5599)', 'c1', { pay: '快捷支付' }),
  // ── 招行 08-08 那封：08-07 当天消费 ────────────────────────
  mk('r10', '2026-08-07', 'pdd', '拼多多平台商户', '33.30', '支出', null, false, '招商银行信用卡(5599)', 'c2', { pay: '快捷支付' }),
  mk('r11', '2026-08-07', 'alipay', '上海盒马网络科技有限公司', '25.80', '支出', '日用百货', true, '招商银行信用卡(5599)', 'c2', { pay: '快捷支付' }),
  mk('r12', '2026-08-07', 'douyin', '杭州绿茶餐饮管理有限公司', '142.00', '支出', '餐饮美食', true, '招商银行信用卡(5599)', 'c2', { pay: '快捷支付' }),
  mk('r13', '2026-08-07', 'alipay', '杭州深度求索', '10.00', '支出', '数字订阅', true, '招商银行信用卡(5599)', 'c2', { pay: '快捷支付' }),
  mk('r14', '2026-08-07', 'meituan', '美团外卖（莘庄店）', '38.60', '支出', '餐饮美食', false, '招商银行信用卡(5599)', 'c2', { pay: '快捷支付' }),
  mk('r15', '2026-08-07', 'alipay', '上海地铁 徐家汇', '4.00', '支出', '交通出行', false, '招商银行信用卡(5599)', 'c2', { pay: '快捷支付' }),
  // ── 支付宝 5 月流水那封（可直接入账 13 笔）─────────────────
  mk('r16', '2026-05-16', 'huabei', '上海地铁-徐家汇', '4.00', '支出', '交通出行', false, '花呗', 'a2', { pay: '花呗' }),
  mk('r17', '2026-05-16', 'huabei', '宜得利上海徐家汇店', '44.60', '支出', '家居家装', true, '花呗', 'a2', { pay: '花呗' }),
  mk('r18', '2026-05-16', 'huabei', '天猫超市 YSL／圣罗兰', '219.00', '支出', '美容美发', true, '花呗', 'a2', { pay: '花呗' }),
  mk('r19', '2026-05-16', 'huabei', 'LINLEE 林里·手打柠檬茶（七宝领展店）', '28.60', '支出', '餐饮美食', true, '花呗', 'a2', { pay: '花呗' }),
  mk('r20', '2026-05-16', 'alipay', '老式大饼（收钱码收款）', '15.00', '支出', '餐饮美食', false, '余额宝', 'a2', { pay: '余额宝' }),
  mk('r21', '2026-05-16', 'huabei', '肯德基宅急送（莘建店）', '26.30', '支出', '餐饮美食', false, '花呗', 'a2', { pay: '花呗' }),
  mk('r22', '2026-05-16', 'apple', 'iCloud 存储空间', '21.00', '支出', '数字订阅', true, '花呗', 'a2', { pay: '花呗' }),
  mk('r23', '2026-05-15', 'alipay', '小杨生煎（莘庄维璟印象城）', '26.87', '支出', '餐饮美食', false, '余额宝', 'a2', { pay: '余额宝' }),
  mk('r24', '2026-05-15', 'alipay', '杭州湾果园报春店', '22.30', '支出', '日用百货', false, '余额宝', 'a2', { pay: '余额宝' }),
  mk('r25', '2026-05-15', 'huabei', '霸王茶姬（上海世博源店）', '18.50', '支出', '餐饮美食', false, '花呗', 'a2', { pay: '花呗' }),
  mk('r26', '2026-05-15', 'alipay', '水清路老式大饼', '9.00', '支出', '餐饮美食', false, '余额宝', 'a2', { pay: '余额宝' }),
  mk('r27', '2026-05-14', 'alipay', '天猫超市退款', '36.90', '收入', '日用百货', false, '余额宝', 'a2', { pay: '余额宝' }),
  mk('r28', '2026-05-14', 'alipay', '上海图书馆文创', '48.00', '支出', '文化休闲', true, '余额宝', 'a2', { pay: '余额宝' }),
  // ── 中行 07-28 那封（可直接入账 3 笔手写 + 2 笔生成）───────
  mk('r29', '2026-07-27', 'unionpay', '国家电网上海电力', '186.34', '支出', '日用百货', true, '中国银行储蓄卡(2841)', 'b1', { pay: '银联代扣' }),
  mk('r30', '2026-07-27', 'unionpay', '上海燃气', '42.00', '支出', '日用百货', true, '中国银行储蓄卡(2841)', 'b1', { pay: '银联代扣' }),
  mk('r31', '2026-07-26', 'unionpay', '工资', '18600.00', '收入', null, false, '中国银行储蓄卡(2841)', 'b1', { pay: '代发' }),

  // ── 需你判断 · 疑似转账（手写 8 笔，取自真实截图）──────────
  mk('t1', '2026-08-06', 'wechat', '微信转账', '182.00', '支出', null, false, '招商银行储蓄卡(8705)', 'c3', { state: 'attention', kind: 'transfer', pay: '快捷支付' }),
  mk('t2', '2026-08-05', 'wechat', '微信转账', '300.00', '支出', null, false, '招商银行储蓄卡(8705)', 'c3', { state: 'attention', kind: 'transfer', pay: '银联快捷支付' }),
  mk('t3', '2026-08-05', 'cmb', '李昶乐', '1485.98', '收入', null, false, '招商银行储蓄卡(8705)', 'c3', { state: 'attention', kind: 'transfer', pay: '网联收款' }),
  mk('t4', '2026-08-03', 'wechat', '微信转账', '3400.00', '支出', null, false, '招商银行储蓄卡(8705)', 'c3', { state: 'attention', kind: 'transfer', pay: '快捷支付', to: '微信零钱' }),
  mk('t5', '2026-08-03', 'wechat', '微信转账', '3400.00', '收入', null, false, '招商银行储蓄卡(8705)', 'c3', { state: 'attention', kind: 'transfer', pay: '快捷退款', to: '微信零钱' }),
  mk('t6', '2026-08-06', 'cmb', '信用卡自动还款', '3280.00', '转账', '信用还款', false, '招商银行储蓄卡(0417)', 'c3', { state: 'attention', kind: 'transfer', to: '招商银行信用卡(5599)', pay: '自动还款' }),
  mk('t7', '2026-07-26', 'boc', '11111078256', '37.10', '收入', null, false, '中国银行借记卡(4045)', 'b1', { state: 'attention', kind: 'transfer', pay: '网上快捷提现' }),
  mk('t8', '2026-08-04', 'cmb', '手机充值-中国移动', '50.00', '支出', null, false, '招商银行信用卡(5599)', 'c2', { state: 'attention', kind: 'transfer', pay: '快捷支付' }),

  // ── 需你判断 · 疑似重复（同渠道两封邮件里的同一笔，已自动合并）──
  mk('d1', '2026-08-08', 'tenpay', '张记油条上海报春路店', '9.00', '支出', '餐饮美食', false, '招商银行信用卡(5599)', 'c1',
    { state: 'attention', kind: 'duplicate', dupOf: 'r6', dupMails: ['c1', 'c3'], pay: '快捷支付' }),
  mk('d2', '2026-08-07', 'meituan', '美团外卖（莘庄店）', '38.60', '支出', '餐饮美食', false, '招商银行信用卡(5599)', 'c2',
    { state: 'attention', kind: 'duplicate', dupOf: 'r14', dupMails: ['c2', 'c3'], pay: '快捷支付' }),
  mk('d3', '2026-05-16', 'huabei', '天猫超市 YSL／圣罗兰', '239.00', '支出', '美容美发', false, '花呗', 'a2',
    { state: 'attention', kind: 'duplicate', dupOf: 'r18', dupMails: ['a2', 'a3'], pay: '花呗' }),

  // ── 需你判断 · 需拆分 ──────────────────────────────────────
  mk('s1', '2026-08-07', 'alipay', '天猫超市（含 3 件商品）', '328.70', '支出', null, false, '招商银行信用卡(5599)', 'c2', { state: 'attention', kind: 'split', pay: '组合支付' }),
  mk('s2', '2026-05-16', 'huabei', '淘宝合并付款（2 个订单）', '96.40', '支出', null, false, '花呗', 'a2', { state: 'attention', kind: 'split', pay: '组合支付' }),

  // ── 需你判断 · 需补备注 ────────────────────────────────────
  mk('n1', '2026-07-27', 'unionpay', '跨行转出', '2000.00', '支出', null, false, '中国银行储蓄卡(2841)', 'b1', { state: 'attention', kind: 'note', pay: '柜面' }),
  mk('n2', '2026-08-06', 'cmb', '二维码收款', '260.00', '收入', null, false, '招商银行储蓄卡(8705)', 'c3', { state: 'attention', kind: 'note', pay: '网联收款' }),

  // ── 已入账样例（微信那 168 笔里最近的几笔）──────────────────
  mk('i1', '2026-07-14', 'wechat', '滴滴出行', '31.50', '支出', '交通出行', false, '微信零钱', 'w3', { state: 'imported', pay: '零钱' }),
  mk('i2', '2026-07-14', 'wechat', '朴朴超市', '86.40', '支出', '日用百货', false, '微信零钱', 'w3', { state: 'imported', pay: '零钱' }),
  mk('i3', '2026-07-13', 'wechat', '万达影城（七宝店）', '78.00', '支出', '文化休闲', false, '微信零钱', 'w3', { state: 'imported', pay: '零钱' }),
  mk('i4', '2026-07-12', 'wechat', '叮咚买菜', '124.60', '支出', '日用百货', false, '微信零钱', 'w3', { state: 'imported', pay: '零钱' }),

  // ── 忽略/清理样例（每种原因一笔手写，其余生成）──────────────
  mk('x1', '2026-07-10', 'wechat', '微信红包', '0.00', '支出', null, false, '微信零钱', 'w3', { state: 'dismissed', reason: 'zero', pay: '零钱' }),
  mk('x2', '2026-07-08', 'wechat', '滴滴出行', '23.10', '支出', '交通出行', false, '微信零钱', 'w3', { state: 'dismissed', reason: 'dup_auto', dupMails: ['w3', 'w4'], pay: '零钱' }),
  mk('x3', '2026-06-26', 'wechat', '测试付款', '1.00', '支出', null, false, '微信零钱', 'w4', { state: 'dismissed', reason: 'user', pay: '零钱' }),
  mk('x4', '2026-06-20', 'wechat', '好德便利店', '12.80', '支出', '日用百货', false, '微信零钱', 'w4', { state: 'dismissed', reason: 'archived', pay: '零钱' }),
]

/* ── 生成层：种子固定，每次打开页面数字一致 ────────────────── */
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const POOL = {
  cmb: {
    merchants: [
      ['alipay', '上海盒马网络科技有限公司', '日用百货'], ['tenpay', '瑞幸咖啡', '餐饮美食'],
      ['alipay', '上海地铁 徐家汇', '交通出行'], ['meituan', '美团外卖（莘庄店）', '餐饮美食'],
      ['tenpay', '全家便利店（报春路店）', '日用百货'], ['douyin', '杭州绿茶餐饮管理有限公司', '餐饮美食'],
      ['alipay', '千里香馄饨报春路', '餐饮美食'], ['pdd', '拼多多平台商户', '日用百货'],
      ['jd', '京东商城', '日用百货'], ['alipay', '曼玲粥店（莘庄店）', '餐饮美食'],
      ['tenpay', '沪上阿姨（七宝店）', '餐饮美食'], ['apple', 'App Store 订阅', '数字订阅'],
    ],
    accounts: ['招商银行信用卡(5599)', '招商银行储蓄卡(8705)'],
    pays: ['快捷支付', '银联快捷支付', '网联收款'],
  },
  wechat: {
    merchants: [
      ['wechat', '滴滴出行', '交通出行'], ['wechat', '朴朴超市', '日用百货'],
      ['wechat', '叮咚买菜', '日用百货'], ['wechat', '好德便利店', '日用百货'],
      ['wechat', '万达影城（七宝店）', '文化休闲'], ['wechat', '老盛昌汤包（莘庄店）', '餐饮美食'],
      ['wechat', '古茗（报春路店）', '餐饮美食'], ['wechat', '罗森便利店（莘庄店）', '日用百货'],
    ],
    accounts: ['微信零钱'],
    pays: ['零钱', '零钱通'],
  },
  alipay: {
    merchants: [
      ['huabei', '肯德基宅急送（莘建店）', '餐饮美食'], ['alipay', '老式大饼（收钱码收款）', '餐饮美食'],
      ['huabei', '罗森便利店（七宝店）', '日用百货'], ['alipay', '杭州湾果园报春店', '日用百货'],
      ['huabei', '霸王茶姬（上海世博源店）', '餐饮美食'], ['alipay', '闲鱼基础软件服务费', '商业服务'],
      ['huabei', '天猫超市', '日用百货'], ['alipay', '上海地铁-莘庄', '交通出行'],
    ],
    accounts: ['余额宝', '花呗'],
    pays: ['余额宝', '花呗', '余额'],
  },
  boc: {
    merchants: [
      ['unionpay', '国家电网上海电力', '日用百货'], ['unionpay', '上海燃气', '日用百货'],
      ['unionpay', '中国移动话费', '数字订阅'], ['unionpay', '物业管理费', '家居家装'],
    ],
    accounts: ['中国银行储蓄卡(2841)', '中国银行借记卡(4045)'],
    pays: ['银联代扣', '网上支付'],
  },
}

function isoShift(base, days) {
  const [y, m, d] = base.split('-').map(Number)
  const t = new Date(y, m - 1, d)
  t.setDate(t.getDate() - days)
  const mm = String(t.getMonth() + 1).padStart(2, '0')
  const dd = String(t.getDate()).padStart(2, '0')
  return `${t.getFullYear()}-${mm}-${dd}`
}

/* 生成 n 笔：日期从 startISO 往回铺，perDay 笔一天 */
function gen(rand, source, state, n, startISO, perDay, mailIds, extra) {
  const pool = POOL[source]
  const out = []
  for (let i = 0; i < n; i += 1) {
    const [platform, merchant, category] = pool.merchants[Math.floor(rand() * pool.merchants.length)]
    const amount = (Math.floor(rand() * 18000) + 300) / 100
    out.push(mk(
      `g-${source}-${state}-${(extra && extra.reason) || ''}${i}`,
      isoShift(startISO, Math.floor(i / perDay)),
      platform, merchant, amount.toFixed(2), '支出',
      state === 'importable' ? category : (state === 'imported' ? category : null),
      state === 'importable' && rand() < 0.4,
      pool.accounts[Math.floor(rand() * pool.accounts.length)],
      mailIds[i % mailIds.length],
      Object.assign({ state, pay: pool.pays[Math.floor(rand() * pool.pays.length)] }, extra || {}),
    ))
  }
  return out
}

const R = mulberry32(20260809)
const GEN = [].concat(
  /* 可直接入账：招行手写 15 + 103、支付宝手写 13、中行手写 3 + 2 → 136 */
  gen(R, 'cmb', 'importable', 103, '2026-08-06', 2, ['c3', 'c2']),
  gen(R, 'boc', 'importable', 2, '2026-07-25', 1, ['b1']),
  /* 需判断补齐：转账 8+10=18、重复 3+6=9、拆分 2+2=4、补备注 2+3=5 → 36 */
  gen(R, 'cmb', 'attention', 10, '2026-07-30', 1, ['c3'], { kind: 'transfer' }).map((r, i) => (
    Object.assign(r, { platform: 'wechat', merchant: '微信转账', category: null, ai: false,
      account: '招商银行储蓄卡(8705)', pay: i % 2 ? '快捷支付' : '银联快捷支付' })
  )),
  gen(R, 'cmb', 'attention', 4, '2026-07-22', 1, ['c3'], { kind: 'duplicate', dupMails: ['c3', 'c4'] }),
  gen(R, 'alipay', 'attention', 2, '2026-05-13', 1, ['a2'], { kind: 'duplicate', dupMails: ['a2', 'a3'] }),
  gen(R, 'cmb', 'attention', 2, '2026-07-18', 1, ['c3'], { kind: 'split', pay: '组合支付' }),
  gen(R, 'cmb', 'attention', 3, '2026-07-16', 1, ['c3'], { kind: 'note' }).map((r) => (
    Object.assign(r, { merchant: '二维码收款', category: null, ai: false })
  )),
  /* 已入账：微信 4+164、招行 100、支付宝 40、中行 12 → 320 */
  gen(R, 'wechat', 'imported', 164, '2026-07-11', 3, ['w2', 'w3', 'w4']),
  gen(R, 'cmb', 'imported', 100, '2026-07-26', 3, ['c4']),
  gen(R, 'alipay', 'imported', 40, '2026-07-05', 3, ['a3']),
  gen(R, 'boc', 'imported', 12, '2026-06-25', 2, ['b1']),
  /* 忽略/清理 210：用户 33、机器判重 74、零元 12、随邮件归档 91 */
  gen(R, 'wechat', 'dismissed', 11, '2026-07-02', 2, ['w3', 'w4'], { reason: 'user' }),
  gen(R, 'cmb', 'dismissed', 12, '2026-07-20', 2, ['c4'], { reason: 'user' }),
  gen(R, 'alipay', 'dismissed', 6, '2026-06-30', 2, ['a3'], { reason: 'user' }),
  gen(R, 'boc', 'dismissed', 3, '2026-06-22', 1, ['b1'], { reason: 'user' }),
  gen(R, 'wechat', 'dismissed', 39, '2026-06-28', 3, ['w3', 'w4'], { reason: 'dup_auto', dupMails: ['w3', 'w4'] }),
  gen(R, 'cmb', 'dismissed', 20, '2026-07-14', 3, ['c4'], { reason: 'dup_auto', dupMails: ['c3', 'c4'] }),
  gen(R, 'alipay', 'dismissed', 10, '2026-06-20', 2, ['a3'], { reason: 'dup_auto', dupMails: ['a2', 'a3'] }),
  gen(R, 'boc', 'dismissed', 4, '2026-06-18', 1, ['b1'], { reason: 'dup_auto', dupMails: ['b1', 'b2'] }),
  gen(R, 'wechat', 'dismissed', 3, '2026-06-15', 1, ['w4'], { reason: 'zero' }).map((r) => Object.assign(r, { amount: '0.00' })),
  gen(R, 'cmb', 'dismissed', 4, '2026-07-10', 1, ['c4'], { reason: 'zero' }).map((r) => Object.assign(r, { amount: '0.00' })),
  gen(R, 'alipay', 'dismissed', 3, '2026-06-12', 1, ['a3'], { reason: 'zero' }).map((r) => Object.assign(r, { amount: '0.00' })),
  gen(R, 'boc', 'dismissed', 1, '2026-06-10', 1, ['b1'], { reason: 'zero' }).map((r) => Object.assign(r, { amount: '0.00' })),
  gen(R, 'wechat', 'dismissed', 29, '2026-06-08', 3, ['w4'], { reason: 'archived' }),
  gen(R, 'cmb', 'dismissed', 38, '2026-07-06', 3, ['c4'], { reason: 'archived' }),
  gen(R, 'alipay', 'dismissed', 17, '2026-06-05', 3, ['a3'], { reason: 'archived' }),
  gen(R, 'boc', 'dismissed', 6, '2026-06-02', 1, ['b1'], { reason: 'archived' }),
)

const ROWS2 = HAND.concat(GEN)

/* 忽略原因的中文与归属：系统做的和人做的分开说 */
const DISMISS_META = {
  user: { label: '你忽略的', flag: '已忽略', who: 'user' },
  dup_auto: { label: '合并的重复', flag: '重复 · 已合并', who: 'system' },
  zero: { label: '清理的零元行', flag: '零元 · 已清理', who: 'system' },
  archived: { label: '随邮件归档', flag: '随邮件归档', who: 'system' },
}

/* ── 纯函数 ─────────────────────────────────────────────── */
const WEEK = ['日', '一', '二', '三', '四', '五', '六']

function fmtAmount(value) {
  const n = Math.abs(Number(value))
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function sign(dir) { return dir === '收入' ? '+' : dir === '转账' ? '' : '-' }
function netOf(rows) {
  return rows.reduce((sum, r) => {
    if (r.dir === '转账') return sum
    return sum + Number(r.amount) * (r.dir === '收入' ? 1 : -1)
  }, 0)
}
function parseDay(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}
function dayLabel(iso) {
  const d = parseDay(iso)
  return `${iso.slice(5, 7)}-${iso.slice(8, 10)} 周${WEEK[d.getDay()]}`
}
function relativeDay(iso) {
  const diff = Math.round((parseDay(TODAY) - parseDay(iso)) / 86400000)
  if (diff <= 0) return '今天'
  if (diff === 1) return '昨天'
  if (diff < 7) return `${diff} 天前`
  if (diff < 60) return `${Math.floor(diff / 7)} 周前`
  return `${diff} 天前`
}
function groupByDay(rows) {
  const map = new Map()
  for (const row of rows) {
    const list = map.get(row.date)
    if (list) list.push(row)
    else map.set(row.date, [row])
  }
  return Array.from(map, ([date, list]) => ({ date, rows: list }))
    .sort((a, b) => (a.date < b.date ? 1 : -1))
}
function accountLabel(row) {
  if (row.dir === '转账' || (row.kind === 'transfer' && row.to)) return `${row.account} → ${row.to || '?'}`
  return row.account
}
function catTone(name) { return CAT_TONE[name] || 'var(--text-tertiary)' }
function mailOf(id) { return MAILS.find((m) => m.id === id) }
function sourceOf(row) { return (mailOf(row.mail) || {}).channel }
function channelOf(key) { return CHANNELS.find((c) => c.key === key) }

Object.assign(window, {
  TODAY, CHANNELS, MAIL_TOTAL, MAILS, MAIL_STATE, ROWS2, CAT_TONE, DISMISS_META,
  fmtAmount, sign, netOf, dayLabel, relativeDay, groupByDay,
  accountLabel, catTone, mailOf, sourceOf, channelOf,
})
