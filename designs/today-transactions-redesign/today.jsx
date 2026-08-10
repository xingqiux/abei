/* 「概况」（原「今天」）。选定方向：时间线。
   前提来自真实账本：最后一笔停在 07-15，8 月一笔没入，收件箱压着 178 笔、
   最早那笔欠了 86 天，69 笔支出没分类，净资产是负的。
   所以这一页说的不是「夜深了 👋」，是「你的账停在哪、欠了多少、先干哪件」。 */

const { useMemo: useTodayMemo } = React

/** 待办：只算「人得动手」的四件事 */
function useTodos(D) {
  return useTodayMemo(() => [
    {
      key: 'importable',
      n: D.inbox.importable,
      label: '笔待入账',
      sub: `最早 ${mmdd(D.inbox.earliest)}，欠了 86 天`,
      icon: 'tray',
      tone: 'brand',
      action: '去入账',
    },
    {
      key: 'attention',
      n: D.inbox.attention,
      label: '笔待确认',
      sub: '疑似转账 22 · 疑似重复 9',
      icon: 'warningCircle',
      tone: 'warn',
      action: '去确认',
    },
    {
      key: 'locked',
      n: D.inbox.locked.length,
      label: '个渠道要密码',
      sub: D.inbox.locked.join('、'),
      icon: 'lockSimple',
      tone: 'warn',
      action: '去解锁',
    },
    {
      key: 'uncat',
      n: D.uncategorized,
      label: '笔未分类',
      sub: '这个账本一条分类都还没有',
      icon: 'tag',
      tone: 'plain',
      action: '让 AI 归类',
    },
  ], [D])
}

/** 账本停摆多少天——这一页从这个事实起头 */
function ledgerGap(D) {
  const last = new Date(`${D.lastEntry}T00:00:00`)
  const today = new Date(`${D.today}T00:00:00`)
  return Math.round((today - last) / 86400000)
}

function Figure({ cap, value, tone, big }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <span className="figure-cap">{cap}</span>
      <span className={`num ${big ? 'figure-l' : 'figure-s'} ${tone}`}>{value}</span>
    </div>
  )
}

function MeterRow({ label, value, max, color }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <span className="figure-cap">{label}</span>
        <span className="num" style={{ fontSize: 12 }}>{money(value)}</span>
      </div>
      <span className="meter"><i style={{ width: `${Math.min(100, (value / max) * 100)}%`, background: color }} /></span>
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════
   概况 · 时间线
   往上是将要发生的，往下是已经发生的，中间那块斜纹是账本的断层。
   左列只留必须一直在的数字，不参与叙事。
   ══════════════════════════════════════════════════════════════ */

function Overview({ D, filled }) {
  const gap = ledgerGap(D)
  const todos = useTodos(D)

  const events = [
    { key: 'u1', when: mmdd(D.upcoming[1].date), rel: '6 天后', node: '', title: D.upcoming[1].title, meta: '周期扣款', amount: -D.upcoming[1].amount },
    { key: 'u0', when: mmdd(D.upcoming[0].date), rel: '2 天后', node: '', title: D.upcoming[0].title, meta: '周期扣款', amount: -D.upcoming[0].amount },
    { key: 'today', when: mmdd(D.today), rel: '今天', node: 'on', title: filled ? '今天入了 3 笔' : '今天还没有入账', meta: filled ? '支出 ¥58.20' : '收件箱里有 137 笔在等', cta: filled ? null : '去入账' },
    { key: 'gap', when: '', rel: '', node: 'warn', gap: true, title: `${gap} 天没有任何入账`, meta: `05-15 起的邮件也还压着 · 收件箱 ${D.inbox.importable + D.inbox.attention} 笔` },
    { key: 'last', when: mmdd(D.lastEntry), rel: '25 天前', node: '', title: '账本最后一笔', meta: '独立站项目尾款（Tammy）', amount: 14000 },
  ]

  // 断层之前账本是活的：把最后几天摊出来，时间线才有下半截
  const earlier = groupByDay(D.tx).slice(1, 5)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="sec-h">
        <h1 className="sec-t" style={{ fontSize: 17 }}>概况</h1>
        <span className="sec-note num">{D.today} {dayOfWeek(D.today)}</span>
      </div>

      <VariantNote>
        原来的问候语横幅和三张 ¥0.00 大卡都撤掉了。这一页现在按时间轴讲：
        未来的周期扣款在上，今天的动静在中，带斜纹的那块是账本断层——你的账停了 <b>{gap}</b> 天，
        最后是断层前还活着的几天。左列只留三个必须一直在的数字。
      </VariantNote>

      <div style={{ display: 'grid', gap: 14, gridTemplateColumns: '236px minmax(0, 1fr)' }}>
        {/* 左列：常驻数字，不参与叙事 */}
        <aside style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Figure cap="净资产" value={money(D.accounts.net)} tone="m-out" big />
            <div className="metergroup">
              <MeterRow label="资产" value={D.accounts.assetTotal} max={Math.abs(D.accounts.liabilityTotal)} color="var(--chart-1)" />
              <MeterRow label="负债" value={Math.abs(D.accounts.liabilityTotal)} max={Math.abs(D.accounts.liabilityTotal)} color="var(--chart-3)" />
            </div>
          </div>

          <div className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span className="figure-cap">本期（8 月）</span>
            {filled ? (
              <>
                <span className="num figure-m m-in">{money(D.period_net, 'always')}</span>
                <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
                  支出 {money(D.period_out)} · 收入 {money(D.period_in)}
                </span>
              </>
            ) : (
              <>
                <span className="num figure-m m-zero">—</span>
                <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>还没有已入账的交易</span>
              </>
            )}
          </div>

          <div className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <span className="figure-cap">待处理</span>
            {todos.map((todo) => (
              <div key={todo.key} style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span className="num figure-s" style={{ minWidth: 30 }}>{todo.n}</span>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)', flex: 1 }}>{todo.label}</span>
              </div>
            ))}
            <button type="button" className="btn btn-primary btn-sm" style={{ marginTop: 4 }}>处理收件箱</button>
          </div>
        </aside>

        {/* 右列：时间轴 */}
        <section className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <SectionHead title="时间线" note="往上是将要发生的，往下是已经发生的" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {events.map((event) => (
              <div className="tl-item" key={event.key}>
                <div style={{ textAlign: 'right', paddingTop: 1 }}>
                  <div className="num" style={{ fontSize: 12, color: 'var(--text-primary)' }}>{event.when}</div>
                  <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>{event.rel}</div>
                </div>
                <div className="tl-rail">
                  <span className={`tl-node ${event.node}`} />
                </div>
                <div
                  style={
                    event.gap
                      ? {
                          borderRadius: 8, padding: '10px 12px',
                          background: 'repeating-linear-gradient(135deg, var(--attention-soft) 0 8px, transparent 8px 16px)',
                          border: '1px dashed var(--attention-mark)',
                        }
                      : { paddingBottom: 2 }
                  }
                >
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: event.gap ? 600 : 500, color: event.gap ? 'var(--attention)' : 'var(--text-primary)' }}>
                      {event.title}
                    </span>
                    {event.amount != null && (
                      <span className={`num figure-s ${event.amount > 0 ? 'm-in' : 'm-out'}`}>
                        {money(event.amount, 'always')}
                      </span>
                    )}
                    {event.cta && <span className="link">{event.cta} <Ic name="caretRight" size={12} /></span>}
                  </div>
                  <div style={{ fontSize: 11.5, color: event.gap ? 'var(--attention)' : 'var(--text-tertiary)' }}>{event.meta}</div>
                </div>
              </div>
            ))}
          </div>

          <hr className="hr" />

          {/* 断层之前：账本活着的那几天，按日折成一行 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span className="figure-cap" style={{ marginBottom: 4 }}>再往前</span>
            {earlier.map((group) => (
              <button
                key={group.day}
                type="button"
                className="tx-row"
                style={{ background: 'transparent' }}
              >
                <span className="num" style={{ width: 54, fontSize: 12, color: 'var(--text-secondary)' }}>{mmdd(group.day)}</span>
                <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)', width: 40 }}>{dayOfWeek(group.day)}</span>
                <span className="truncate" style={{ flex: 1, minWidth: 0, fontSize: 12.5, textAlign: 'left' }}>
                  {group.rows[0].desc}
                  {group.rows.length > 1 && (
                    <span style={{ color: 'var(--text-tertiary)' }}> 等 {group.rows.length} 笔</span>
                  )}
                </span>
                <span className={`num tx-amt ${group.net > 0 ? 'm-in' : 'm-out'}`} style={{ width: 100 }}>
                  {money(group.net, 'always')}
                </span>
              </button>
            ))}
            <span className="link" style={{ marginTop: 6 }}>
              到交易页看全部 <Ic name="caretRight" size={12} />
            </span>
          </div>
        </section>
      </div>
    </div>
  )
}

Object.assign(window, { Overview, Figure })
