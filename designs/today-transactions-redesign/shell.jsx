/* 应用外壳 + 两页共用的格式化/取数助手。
   外壳照抄生产版的视觉词汇（左侧导航 216px、顶栏搜索 + 日期范围 + 记一笔），
   这次重做只动「今天」和「交易」两页的正文，外壳保持原样才看得出改了什么。 */

const { useState, useMemo, useRef, useEffect } = React

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 千分位 + 两位小数，绝对值 */
function fmt(n) {
  return Math.abs(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** 带符号金额。sign='auto' 时负数才带减号；'always' 时正数也带加号 */
function money(n, sign = 'auto', symbol = '¥') {
  const body = `${symbol}${fmt(n)}`
  if (n < 0) return `-${body}`
  if (sign === 'always' && n > 0) return `+${body}`
  return body
}

/** 环心、图例这种窄位置用：上万就折成「万」，六位数才塞得下 */
function moneyShort(n, symbol = '¥') {
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  if (abs >= 10000) return `${sign}${symbol}${(abs / 10000).toFixed(2)}万`
  return `${sign}${symbol}${fmt(abs)}`
}

/** 支出不上色（用正文色），收入红，转账蓝——跟生产版 token 一致 */
function amtClass(type) {
  return type === 'in' ? 'm-in' : type === 'move' ? 'm-move' : 'm-out'
}

/** 一笔流水在「净流」口径下的符号金额：转账内部搬钱，不计入 */
function signed(t) {
  return t.type === 'in' ? t.amount : t.type === 'out' ? -t.amount : 0
}

/** 支出看付款账户，收入看收款账户 */
function fundingOf(t) {
  return t.type === 'in' ? t.to : t.from
}

/** 对手方：支出看目标，收入看来源 */
function counterOf(t) {
  return t.type === 'in' ? t.from : t.to
}

function dayOfWeek(date) {
  return WEEK[new Date(`${date}T00:00:00`).getDay()]
}

function mmdd(date) {
  return date.slice(5)
}

/** 今天 / 昨天 / N 天前；再远就不说了，日期本身够用 */
function relativeDay(date, today) {
  const a = new Date(`${date}T00:00:00`)
  const b = new Date(`${today}T00:00:00`)
  const days = Math.round((b - a) / 86400000)
  if (days === 0) return '今天'
  if (days === 1) return '昨天'
  if (days > 1 && days <= 30) return `${days} 天前`
  return null
}

/** 按日分组，保留原顺序，每组带当日净额 */
function groupByDay(rows) {
  const groups = []
  let current = null
  for (const row of rows) {
    if (!current || current.day !== row.date) {
      current = { day: row.date, rows: [], net: 0 }
      groups.push(current)
    }
    current.rows.push(row)
    current.net += signed(row)
  }
  for (const group of groups) group.net = Math.round(group.net * 100) / 100
  return groups
}

const NAV = [
  { key: 'today', label: '概况', icon: 'squaresFour' },
  { key: 'inbox', label: '账单收件箱', icon: 'tray', badge: 188, dot: true },
  { key: 'tx', label: '交易', icon: 'arrowsLeftRight' },
  { key: 'assistant', label: '财务助手', icon: 'sparkle' },
  { key: 'accounts', label: '账户', icon: 'wallet' },
  { key: 'budget', label: '预算', icon: 'money' },
  { key: 'cats', label: '分类与标签', icon: 'tag' },
  { key: 'analysis', label: '分析', icon: 'chartBar' },
  { key: 'settings', label: '设置', icon: 'gear' },
]

function Sidebar({ page, onPage }) {
  return (
    <nav className="side" aria-label="主导航">
      <div className="brand">
        <span className="brand-mark">
          <Ic name="scales" size={24} />
        </span>
        <span>
          <span className="brand-name" style={{ display: 'block' }}>abei</span>
          <span className="brand-sub">阿贝</span>
        </span>
      </div>
      {NAV.map((item) => (
        <button
          key={item.key}
          type="button"
          className="nav-item"
          aria-current={page === item.key ? 'true' : undefined}
          onClick={() => onPage(item.key)}
        >
          <Ic name={item.icon} size={17} />
          {item.label}
          {item.badge && <span className="nav-badge num">{item.badge}</span>}
          {item.dot && <span className="nav-dot" aria-hidden="true" />}
        </button>
      ))}
    </nav>
  )
}

function Topbar({ rangeLabel }) {
  return (
    <header className="topbar">
      <div className="search">
        <span className="ic"><Ic name="magnifyingGlass" size={15} /></span>
        <input placeholder="搜索，或 Cmd+K" aria-label="搜索" readOnly />
        <kbd>/</kbd>
      </div>
      <button type="button" className="rangepick">
        <Ic name="calendarBlank" size={15} />
        <span className="num">{rangeLabel}</span>
        <Ic name="caretDown" size={12} />
      </button>
      <button type="button" className="btn btn-primary">
        <Ic name="plus" size={14} />
        记一笔
      </button>
      <span
        style={{
          width: 30, height: 30, borderRadius: '50%', background: 'var(--brand-soft)',
          color: 'var(--brand-text)', display: 'grid', placeItems: 'center', flex: 'none',
        }}
      >
        <Ic name="userCircle" size={19} />
      </span>
    </header>
  )
}

/** 段落标题 + 右侧补充说明 */
function SectionHead({ title, note, action }) {
  return (
    <div className="sec-h">
      <h2 className="sec-t">{title}</h2>
      {note && <span className="sec-note">{note}</span>}
      {action}
    </div>
  )
}

/** 每个方向上方那条说明：讲清这版在解决哪条抱怨 */
function VariantNote({ children }) {
  return (
    <p className="variant-note">
      <Ic name="eye" size={15} style={{ marginTop: 2, color: 'var(--text-tertiary)' }} />
      <span>{children}</span>
    </p>
  )
}

function Seg({ value, options, onChange, label }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

Object.assign(window, {
  fmt, money, moneyShort, amtClass, signed, fundingOf, counterOf,
  dayOfWeek, mmdd, relativeDay, groupByDay,
  Sidebar, Topbar, SectionHead, VariantNote, Seg,
})
