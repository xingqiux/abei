/* 原型数据。取自真实截图里的流水（招行信用卡每日消费、支付宝流水明细、微信账单），
   改了金额尾数，保留了原来的商户名和「平台-商户」这种描述格式 —— 重做的核心动作之一
   就是把这个前缀从描述里拆出来变成平台标。 */

const TODAY = '2026-08-09'

const CHANNELS = [
  { key: 'cmb', label: '招商银行', platform: 'cmb' },
  { key: 'alipay', label: '支付宝', platform: 'alipay' },
  { key: 'wechat', label: '微信支付', platform: 'wechat' },
  { key: 'boc', label: '中国银行', platform: 'boc' },
]

const MAILS = [
  { id: 'm1', channel: 'cmb', subject: '招商银行信用卡每日消费', at: '08-09', state: 'ok', count: 9 },
  { id: 'm2', channel: 'cmb', subject: '招商银行信用卡每日消费', at: '08-08', state: 'ok', count: 6 },
  { id: 'm3', channel: 'cmb', subject: '招商银行信用卡账单', at: '08-02', state: 'done', count: 0 },
  { id: 'm4', channel: 'alipay', subject: '支付宝交易流水明细（5 月）', at: '08-06', state: 'ok', count: 18 },
  { id: 'm5', channel: 'alipay', subject: '支付宝交易流水明细（4 月）', at: '07-08', state: 'done', count: 0 },
  { id: 'm6', channel: 'wechat', subject: '微信支付账单流水', at: '08-05', state: 'locked', count: 0 },
  { id: 'm7', channel: 'wechat', subject: '微信支付账单流水', at: '07-15', state: 'ok', count: 6 },
  { id: 'm8', channel: 'wechat', subject: '微信支付账单流水', at: '07-06', state: 'done', count: 0 },
  { id: 'm9', channel: 'wechat', subject: '微信支付账单流水', at: '06-26', state: 'done', count: 0 },
  { id: 'm10', channel: 'boc', subject: '中国银行借记卡对账单', at: '07-28', state: 'ok', count: 3 },
  { id: 'm11', channel: 'boc', subject: '中国银行借记卡对账单', at: '06-28', state: 'failed', count: 0 },
]

const MAIL_STATE = {
  ok: { label: '已解析', kind: 'ok' },
  locked: { label: '待解锁', kind: 'warn' },
  failed: { label: '解析失败', kind: 'danger' },
  done: { label: '已入账完', kind: 'muted' },
}

/* 分类色只做区分，不承载语义 —— 跟阿贝的 --cat-* 色板对齐 */
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

/** row: [id, 日期, 平台, 商户, 金额, 方向, 分类, AI建议?, 账户, 邮件] */
function mk(id, date, platform, merchant, amount, dir, category, ai, account, mail, extra) {
  return Object.assign({
    id, date, platform, merchant, amount, dir,
    category: category || null, ai: !!ai, account, mail,
    reason: null, group: 'importable',
  }, extra || {})
}

const ROWS = [
  // ── 招行 08-09 那封：08-08 当天消费 ─────────────────────────
  mk('r1', '2026-08-08', 'alipay', '上海盒马网络科技有限公司', '56.10', '支出', '日用百货', true, '招商银行信用卡(5599)', 'm1'),
  mk('r2', '2026-08-08', 'alipay', '上海盒马网络科技有限公司', '71.79', '支出', '日用百货', true, '招商银行信用卡(5599)', 'm1'),
  mk('r3', '2026-08-08', 'tenpay', '暖暖家（七浦路服装批发市场）', '100.00', '支出', '服饰装扮', true, '招商银行信用卡(5599)', 'm1'),
  mk('r4', '2026-08-08', 'alipay', '上海崎本的店面包静安大悦城店', '26.00', '支出', '餐饮美食', true, '招商银行信用卡(5599)', 'm1'),
  mk('r5', '2026-08-08', 'alipay', '上海福满家便利有限公司', '3.00', '支出', '日用百货', true, '招商银行信用卡(5599)', 'm1'),
  mk('r6', '2026-08-08', 'tenpay', '张记油条上海报春路店', '9.00', '支出', '餐饮美食', false, '招商银行信用卡(5599)', 'm1'),
  mk('r7', '2026-08-08', 'tenpay', '张记油条上海报春路店', '8.00', '支出', '餐饮美食', false, '招商银行信用卡(5599)', 'm1'),
  mk('r8', '2026-08-08', 'tenpay', '瑞幸咖啡', '9.90', '支出', '餐饮美食', false, '招商银行信用卡(5599)', 'm1'),
  mk('r9', '2026-08-08', 'alipay', '千里香馄饨报春路', '23.00', '支出', '餐饮美食', false, '招商银行信用卡(5599)', 'm1'),

  // ── 招行 08-08 那封：08-07 当天消费 ─────────────────────────
  mk('r10', '2026-08-07', 'pdd', '拼多多平台商户', '33.30', '支出', null, false, '招商银行信用卡(5599)', 'm2'),
  mk('r11', '2026-08-07', 'alipay', '上海盒马网络科技有限公司', '25.80', '支出', '日用百货', true, '招商银行信用卡(5599)', 'm2'),
  mk('r12', '2026-08-07', 'douyin', '杭州绿茶餐饮管理有限公司', '142.00', '支出', '餐饮美食', true, '招商银行信用卡(5599)', 'm2'),
  mk('r13', '2026-08-07', 'alipay', '杭州深度求索', '10.00', '支出', '数字订阅', true, '招商银行信用卡(5599)', 'm2'),
  mk('r14', '2026-08-07', 'meituan', '美团外卖（莘庄店）', '38.60', '支出', '餐饮美食', false, '招商银行信用卡(5599)', 'm2'),
  mk('r15', '2026-08-07', 'alipay', '上海地铁 徐家汇', '4.00', '支出', '交通出行', false, '招商银行信用卡(5599)', 'm2'),

  // ── 支付宝流水明细：5 月那批 ────────────────────────────────
  mk('r16', '2026-05-16', 'huabei', '上海地铁-徐家汇', '4.00', '支出', '交通出行', false, '花呗', 'm4'),
  mk('r17', '2026-05-16', 'huabei', '宜得利上海徐家汇店', '44.60', '支出', '家居家装', true, '花呗', 'm4'),
  mk('r18', '2026-05-16', 'huabei', '上海地铁-莘庄', '4.00', '支出', '交通出行', false, '花呗', 'm4'),
  mk('r19', '2026-05-16', 'huabei', '天猫超市 YSL／圣罗兰', '219.00', '支出', '美容美发', true, '花呗', 'm4'),
  mk('r20', '2026-05-16', 'huabei', 'LINLEE 林里·手打柠檬茶（七宝领展店）', '28.60', '支出', '餐饮美食', true, '花呗', 'm4'),
  mk('r21', '2026-05-16', 'huabei', '天猫超市 YSL／圣罗兰', '239.00', '支出', '美容美发', true, '花呗', 'm4'),
  mk('r22', '2026-05-16', 'alipay', '老式大饼（收钱码收款）', '15.00', '支出', '餐饮美食', false, '余额宝', 'm4'),
  mk('r23', '2026-05-16', 'huabei', '肯德基宅急送（莘建店）', '26.30', '支出', '餐饮美食', false, '花呗', 'm4'),
  mk('r24', '2026-05-16', 'huabei', '肯德基宅急送（莘建店）', '29.50', '支出', '餐饮美食', false, '花呗', 'm4'),
  mk('r25', '2026-05-16', 'apple', 'iCloud 存储空间', '21.00', '支出', '数字订阅', true, '花呗', 'm4'),
  mk('r26', '2026-05-15', 'alipay', '小杨生煎（莘庄维璟印象城）', '26.87', '支出', '餐饮美食', false, '余额宝', 'm4'),
  mk('r27', '2026-05-15', 'alipay', '杭州湾果园报春店', '22.30', '支出', '日用百货', false, '余额宝', 'm4'),
  mk('r28', '2026-05-15', 'alipay', '闲鱼基础软件服务费', '0.30', '支出', '商业服务', false, '余额宝', 'm4'),
  mk('r29', '2026-05-15', 'huabei', '霸王茶姬（上海世博源店）', '18.50', '支出', '餐饮美食', false, '花呗', 'm4'),
  mk('r30', '2026-05-15', 'alipay', '水清路老式大饼', '9.00', '支出', '餐饮美食', false, '余额宝', 'm4'),
  mk('r31', '2026-05-14', 'alipay', '天猫超市退款', '36.90', '收入', '日用百货', false, '余额宝', 'm4'),
  mk('r32', '2026-05-14', 'huabei', '罗森便利店（七宝店）', '13.20', '支出', '日用百货', false, '花呗', 'm4'),
  mk('r33', '2026-05-14', 'alipay', '上海图书馆文创', '48.00', '支出', '文化休闲', true, '余额宝', 'm4'),

  // ── 微信 07-15 那封 ─────────────────────────────────────────
  mk('r34', '2026-07-14', 'wechat', '滴滴出行', '31.50', '支出', '交通出行', true, '微信零钱', 'm7'),
  mk('r35', '2026-07-14', 'wechat', '朴朴超市', '86.40', '支出', '日用百货', true, '微信零钱', 'm7'),
  mk('r36', '2026-07-13', 'wechat', '万达影城（七宝店）', '78.00', '支出', '文化休闲', false, '微信零钱', 'm7'),
  mk('r37', '2026-07-13', 'wechat', '好德便利店', '12.80', '支出', '日用百货', false, '微信零钱', 'm7'),
  mk('r38', '2026-07-12', 'wechat', '叮咚买菜', '124.60', '支出', '日用百货', true, '微信零钱', 'm7'),
  mk('r39', '2026-07-12', 'wechat', '同事转账 · 团建 AA', '160.00', '收入', null, false, '微信零钱', 'm7'),

  // ── 中行 07-28 那封 ─────────────────────────────────────────
  mk('r40', '2026-07-27', 'unionpay', '国家电网上海电力', '186.34', '支出', '日用百货', true, '中国银行储蓄卡(2841)', 'm10'),
  mk('r41', '2026-07-27', 'unionpay', '上海燃气', '42.00', '支出', '日用百货', true, '中国银行储蓄卡(2841)', 'm10'),
  mk('r42', '2026-07-26', 'unionpay', '工资', '18600.00', '收入', null, false, '中国银行储蓄卡(2841)', 'm10'),

  // ── 待确认：需要人点一下才知道怎么记的 ───────────────────────
  mk('a1', '2026-08-06', 'cmb', '信用卡自动还款', '3280.00', '转账', '信用还款', false, '招商银行储蓄卡(0417)', 'm2',
    { group: 'attention', reason: '疑似转账', kind: 'transfer', to: '招商银行信用卡(5599)' }),
  mk('a2', '2026-07-26', 'boc', '还款 花呗', '1260.00', '转账', '信用还款', false, '中国银行储蓄卡(2841)', 'm10',
    { group: 'attention', reason: '疑似转账', kind: 'transfer', to: '花呗' }),
  mk('a3', '2026-08-08', 'tenpay', '张记油条上海报春路店', '9.00', '支出', '餐饮美食', false, '招商银行信用卡(5599)', 'm1',
    { group: 'attention', reason: '疑似重复', kind: 'duplicate', dupOf: 'r6' }),
  mk('a4', '2026-05-16', 'huabei', '天猫超市 YSL／圣罗兰', '219.00', '支出', '美容美发', false, '花呗', 'm4',
    { group: 'attention', reason: '疑似重复', kind: 'duplicate', dupOf: 'r19' }),
  mk('a5', '2026-08-07', 'alipay', '天猫超市（含 3 件商品）', '328.70', '支出', null, false, '招商银行信用卡(5599)', 'm2',
    { group: 'attention', reason: '需拆分', kind: 'split' }),
  mk('a6', '2026-07-27', 'unionpay', '跨行转出', '2000.00', '支出', null, false, '中国银行储蓄卡(2841)', 'm10',
    { group: 'attention', reason: '需补备注', kind: 'note' }),
]

/* ── 纯函数们 ───────────────────────────────────────────── */

const WEEK = ['日', '一', '二', '三', '四', '五', '六']

function fmtAmount(value) {
  const n = Math.abs(Number(value))
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function sign(dir) {
  return dir === '收入' ? '+' : dir === '转账' ? '' : '-'
}

/** 当日/当批合计：收入记正、支出记负，转账不计入收支 */
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

/** 「今天 / 昨天 / 3 天前 / 84 天前」—— 队列里最老的那几笔要一眼看出积压 */
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
}

function groupByMail(rows) {
  const map = new Map()
  for (const row of rows) {
    const list = map.get(row.mail)
    if (list) list.push(row)
    else map.set(row.mail, [row])
  }
  return Array.from(map, ([mailId, list]) => ({
    mail: MAILS.find((m) => m.id === mailId),
    rows: list,
  }))
}

/** 账户列只留「钱从哪个账户走的」，商户端已经在描述里了，再印一遍就是噪音 */
function accountLabel(row) {
  if (row.dir === '转账') return `${row.account} → ${row.to || '?'}`
  return row.account
}

function platformLabel(key) {
  return (window.PLATFORMS[key] || window.PLATFORMS.other).label
}

function catTone(name) {
  return CAT_TONE[name] || 'var(--text-tertiary)'
}

function mailOf(id) {
  return MAILS.find((m) => m.id === id)
}

Object.assign(window, {
  TODAY, CHANNELS, MAILS, MAIL_STATE, ROWS, CAT_TONE,
  fmtAmount, sign, netOf, dayLabel, relativeDay, groupByDay, groupByMail,
  accountLabel, platformLabel, catTone, mailOf,
})
