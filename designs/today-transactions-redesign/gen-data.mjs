/**
 * 从本机 Firefly 拉到的真实数据 → data.jsx。
 * 原型里不编数字：描述、账户、金额、日期全部来自 2026-07 的真实账本。
 * 重跑：node gen-data.mjs <scratchdir>
 */
import fs from 'node:fs'
import path from 'node:path'

const S = process.argv[2]
const rows = JSON.parse(fs.readFileSync(path.join(S, 'rows.json'), 'utf8'))
const accs = JSON.parse(fs.readFileSync(path.join(S, 'accs.json'), 'utf8'))

const num = (s) => Number(s)
const round2 = (n) => Math.round(n * 100) / 100

// 交易：压成原型要用的最小形状
const tx = rows.map((r, i) => ({
  id: r.id,
  seq: i,
  date: r.d,
  desc: r.desc,
  type: r.ty === 'withdrawal' ? 'out' : r.ty === 'deposit' ? 'in' : 'move',
  amount: round2(num(r.amt)),
  from: r.src,
  to: r.dst,
  cat: r.cat,
  tags: r.tags,
  budget: r.bud,
}))

// 账户：资产 / 负债，用于净资产环形
const asset = (accs.asset ?? []).concat(accs.cash ?? [])
const liab = accs.liabilities ?? []
const sum = (list) => round2(list.reduce((acc, a) => acc + num(a.b), 0))
const accounts = {
  assets: asset.map((a) => ({ name: a.n, balance: round2(num(a.b)) })),
  liabilities: liab.map((a) => ({ name: a.n, balance: round2(num(a.b)) })),
  assetTotal: sum(asset),
  liabilityTotal: sum(liab),
}
accounts.net = round2(accounts.assetTotal + accounts.liabilityTotal)

// 本期（07 月）收支
const out = round2(tx.filter((t) => t.type === 'out').reduce((a, t) => a + t.amount, 0))
const inc = round2(tx.filter((t) => t.type === 'in').reduce((a, t) => a + t.amount, 0))

// 分类占比：没分类的归「未分类」，跟生产口径一致
const byCat = new Map()
for (const t of tx) {
  if (t.type !== 'out') continue
  const key = t.cat ?? '未分类'
  byCat.set(key, round2((byCat.get(key) ?? 0) + t.amount))
}
const cats = [...byCat.entries()]
  .map(([name, value]) => ({ name, value }))
  .sort((a, b) => b.value - a.value)

// 账户维度：交易页「按账户分组」和今天页都要用
const byAcct = new Map()
for (const t of tx) {
  const key = t.type === 'in' ? t.to : t.from
  const cur = byAcct.get(key) ?? { name: key, out: 0, in: 0, count: 0 }
  if (t.type === 'out') cur.out = round2(cur.out + t.amount)
  else if (t.type === 'in') cur.in = round2(cur.in + t.amount)
  cur.count += 1
  byAcct.set(key, cur)
}

// 余额序列：从今天的真实资产余额往回倒推 40 天。
// 07-15 之后一笔都没有，所以尾巴必然是一条平线——这不是稳定，是账本停了。
const DAYS = 40
const today = '2026-08-09'
const dayList = []
for (let i = DAYS - 1; i >= 0; i -= 1) {
  const d = new Date(`${today}T00:00:00`)
  d.setDate(d.getDate() - i)
  dayList.push(d.toISOString().slice(0, 10))
}
const netByDay = new Map()
for (const t of tx) {
  const delta = t.type === 'in' ? t.amount : t.type === 'out' ? -t.amount : 0
  netByDay.set(t.date, round2((netByDay.get(t.date) ?? 0) + delta))
}
const balanceSeries = []
{
  let balance = accounts.assetTotal
  const back = []
  for (let i = dayList.length - 1; i >= 0; i -= 1) {
    back.push(round2(balance))
    balance = round2(balance - (netByDay.get(dayList[i]) ?? 0))
  }
  balanceSeries.push(...back.reverse())
}

const payload = {
  period: { start: '2026-07-01', end: '2026-07-31', label: '上月' },
  periodNow: { start: '2026-08-01', end: '2026-08-31' },
  today,
  lastEntry: '2026-07-15',
  balanceSeries,
  tx,
  accounts,
  period_out: out,
  period_in: inc,
  period_net: round2(inc - out),
  cats,
  byAcct: [...byAcct.values()].sort((a, b) => b.out - a.out),
  // 收件箱欠账：跟生产页当前真实计数一致
  inbox: { importable: 137, attention: 41, dismissed: 204, imported: 320, locked: ['支付宝', '微信支付'], earliest: '2026-05-15' },
  // 未来 7 天周期扣款
  upcoming: [
    { title: 'iCloud 200GB', date: '2026-08-11', amount: 21 },
    { title: '房租', date: '2026-08-15', amount: 4200 },
  ],
  uncategorized: tx.filter((t) => t.cat == null && t.type === 'out').length,
}

const body = `/* 本文件由 gen-data.mjs 生成，勿手改。数据取自本机 Firefly 2026-07 真实账本。 */
window.DATA = ${JSON.stringify(payload, null, 1)}
`
fs.writeFileSync(new URL('./data.jsx', import.meta.url), body)
console.log('data.jsx', body.length, 'bytes ·', tx.length, '笔 ·', cats.length, '个分类')
