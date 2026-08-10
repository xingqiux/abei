/* 「交易」。选定方向：紧凑表格 + 右侧面板（原 B 与 C 合并）。
   四条抱怨对应四件事：筛选栏收起、行拉出层次（改成列对齐 + 面板承载细节）、
   补概览与批量、分页换滚动。
   数据是 2026-07 的真实 80 笔，包括那 69 笔没分类的支出。 */

const { useState: useTxS, useMemo: useTxM, useRef: useTxR, useEffect: useTxE, useCallback: useTxC } = React

const TX_TABS = [
  { value: 'all', label: '全部' },
  { value: 'out', label: '支出' },
  { value: 'in', label: '收入' },
  { value: 'move', label: '转账' },
]

/** tab + 关键词 + 选中集 + 滚动加载游标 */
function useTxView(D, step = 40) {
  const [tab, setTab] = useTxS('all')
  const [keyword, setKeyword] = useTxS('')
  const [selected, setSelected] = useTxS(() => new Set())
  const [shown, setShown] = useTxS(step)

  const rows = useTxM(() => {
    const key = keyword.trim()
    return D.tx.filter((t) => {
      if (tab !== 'all' && t.type !== tab) return false
      if (key && !`${t.desc}${t.from}${t.to}`.includes(key)) return false
      return true
    })
  }, [D, tab, keyword])

  const counts = useTxM(() => ({
    all: D.tx.length,
    out: D.tx.filter((t) => t.type === 'out').length,
    in: D.tx.filter((t) => t.type === 'in').length,
    move: D.tx.filter((t) => t.type === 'move').length,
  }), [D])

  // 换 tab / 换关键词就把游标收回去，否则会停在上一次滚到的位置
  useTxE(() => { setShown(step) }, [tab, keyword, step])

  const toggle = (id) => setSelected((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  return { tab, setTab, keyword, setKeyword, selected, setSelected, toggle, rows, counts, shown, setShown }
}

/** 本期概览：笔数 / 支出 / 收入 / 净流。原版一个数都没有，只有右上角「共 122 笔」 */
function txStats(rows) {
  let out = 0
  let inc = 0
  for (const t of rows) {
    if (t.type === 'out') out += t.amount
    else if (t.type === 'in') inc += t.amount
  }
  return {
    count: rows.length,
    out: Math.round(out * 100) / 100,
    in: Math.round(inc * 100) / 100,
    net: Math.round((inc - out) * 100) / 100,
  }
}

function amountText(t) {
  if (t.type === 'in') return money(t.amount, 'always')
  if (t.type === 'out') return money(-t.amount)
  return money(t.amount)
}

function TxTabs({ tab, setTab, counts }) {
  return (
    <div className="tabs" role="tablist" aria-label="交易类型">
      {TX_TABS.map((item) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          aria-selected={tab === item.value}
          onClick={() => setTab(item.value)}
        >
          {item.label}
          <span className="n num">{counts[item.value]}</span>
        </button>
      ))}
    </div>
  )
}

/** 筛选：收起成一个按钮 + 一排已选 chip。原版六个控件常驻，常年不用却一直占地方 */
function FilterBar({ keyword, setKeyword, active, onRemove, onClear, extra }) {
  const [open, setOpen] = useTxS(false)
  return (
    <div className="filterbar">
      <div className="search" style={{ maxWidth: 260, flex: '0 1 260px' }}>
        <span className="ic"><Ic name="magnifyingGlass" size={14} /></span>
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜描述、账户"
          aria-label="关键词"
          style={{ height: 30 }}
        />
      </div>

      <div style={{ position: 'relative' }}>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <Ic name="funnel" size={14} />
          筛选
          {active.length > 0 && <span className="num" style={{ color: 'var(--brand-text)' }}>{active.length}</span>}
          <Ic name="caretDown" size={11} />
        </button>
        {open && (
          <div className="popover" onMouseLeave={() => setOpen(false)}>
            <label className="field-l">账户
              <select className="inp" defaultValue=""><option value="">全部账户</option><option>招商银行</option><option>微信钱包</option><option>中国银行</option></select>
            </label>
            <label className="field-l">分类
              <select className="inp" defaultValue=""><option value="">全部分类</option><option>未分类</option></select>
            </label>
            <label className="field-l">标签
              <select className="inp" defaultValue=""><option value="">全部标签</option><option>小琪</option><option>微信提现</option></select>
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <label className="field-l" style={{ flex: 1 }}>金额 ≥<input className="inp num" inputMode="decimal" /></label>
              <label className="field-l" style={{ flex: 1 }}>金额 ≤<input className="inp num" inputMode="decimal" /></label>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={onClear}>清空</button>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(false)}>应用</button>
            </div>
          </div>
        )}
      </div>

      {active.map((item) => (
        <button key={item.key} type="button" className="chip chip-brand" onClick={() => onRemove(item.key)}>
          {item.label}
          <Ic name="x" size={11} />
        </button>
      ))}
      {extra}
    </div>
  )
}

function StatStrip({ stats }) {
  return (
    <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 0, flexWrap: 'wrap' }}>
      <StatCell cap="笔数" value={stats.count} plain />
      <StatCell cap="支出" value={money(-stats.out)} tone="m-out" />
      <StatCell cap="收入" value={money(stats.in, 'always')} tone="m-in" />
      <StatCell cap="净流" value={money(stats.net, 'always')} tone={stats.net >= 0 ? 'm-in' : 'm-out'} last />
    </div>
  )
}

function StatCell({ cap, value, tone, plain, last }) {
  return (
    <div
      style={{
        padding: '9px 16px', display: 'flex', alignItems: 'baseline', gap: 8,
        borderRight: last ? 'none' : '1px solid var(--border-subtle)',
      }}
    >
      <span className="figure-cap">{cap}</span>
      <span className={`num figure-s ${plain ? '' : tone}`}>{value}</span>
    </div>
  )
}

/** 滚动加载：到底了就明说，别让人以为还有 */
function ScrollTail({ shown, total, onMore }) {
  const ref = useTxR(null)
  useTxE(() => {
    const node = ref.current
    if (!node || shown >= total) return undefined
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) onMore()
    }, { rootMargin: '300px' })
    io.observe(node)
    return () => io.disconnect()
  }, [shown, total, onMore])
  return (
    <div ref={ref} style={{ padding: '12px 4px', textAlign: 'center', fontSize: 11.5, color: 'var(--text-tertiary)' }}>
      {shown >= total ? `到底了 · 共 ${total} 笔` : `正在加载…已显示 ${shown} / ${total} 笔`}
    </div>
  )
}

/** 面板收起时才需要它：勾选后从底部升起 */
function BulkBar({ count, onClear, onOpenPane }) {
  return (
    <div className="bulkbar">
      <span style={{ fontSize: 12.5, color: 'var(--text-secondary)', paddingLeft: 4 }}>
        已选 <span className="num" style={{ color: 'var(--text-primary)' }}>{count}</span> 笔
      </span>
      <button type="button" className="btn btn-secondary btn-sm"><Ic name="tag" size={13} />改分类</button>
      <button type="button" className="btn btn-secondary btn-sm"><Ic name="money" size={13} />改预算</button>
      <button type="button" className="btn btn-secondary btn-sm">加标签</button>
      <button type="button" className="btn btn-secondary btn-sm"><Ic name="trash" size={13} />删除</button>
      <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={onOpenPane}>展开面板</button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onClear}>取消选择</button>
    </div>
  )
}

/* 这个账本 100% 未分类。给每行都挂一个「未分类」虚线签，等于把同一句话印 69 遍，
   正是「行信息层次差」的病灶。分类列保留（列对齐需要占位），空值只写一个 `—`，
   「没分类」这件事提到列表上方说一次（见 UncatTip）。 */
function CatCell({ cat }) {
  if (cat) return <span className="chip">{cat}</span>
  return <span style={{ color: 'var(--text-tertiary)' }}>—</span>
}

/** 未分类只说一次，说在列表上方，并且直接给动作 */
function UncatTip({ rows }) {
  const missing = rows.filter((t) => !t.cat).length
  if (missing === 0) return null
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: '8px 12px', borderRadius: 8,
        background: 'var(--brand-soft)', color: 'var(--text-primary)', fontSize: 12.5,
      }}
    >
      <Ic name="sparkle" size={15} style={{ color: 'var(--brand-text)' }} />
      <span>
        {missing === rows.length ? (
          <>这 <span className="num" style={{ fontWeight: 600 }}>{rows.length}</span> 笔全都还没分类</>
        ) : (
          <>
            这 <span className="num" style={{ fontWeight: 600 }}>{rows.length}</span> 笔里有{' '}
            <span className="num" style={{ fontWeight: 600 }}>{missing}</span> 笔还没分类
          </>
        )}
      </span>
      <span className="link" style={{ marginLeft: 'auto' }}>
        让 AI 归一遍 <Ic name="caretRight" size={12} />
      </span>
      <span className="link">只看未分类</span>
    </div>
  )
}

function DayHead({ group, D }) {
  const rel = relativeDay(group.day, D.today)
  return (
    // 组头也钉住，跟在列头下面——滚到一半还知道自己在哪一天
    <div className="tx-day" style={{ position: 'sticky', top: 30, zIndex: 4 }}>
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <b className="num">{mmdd(group.day)}</b>
        <span>{dayOfWeek(group.day)}</span>
        {rel && <span style={{ color: 'var(--text-tertiary)' }}>{rel}</span>}
        <span className="num" style={{ color: 'var(--text-tertiary)' }}>{group.rows.length} 笔</span>
      </span>
      <span className={`num ${group.net > 0 ? 'm-in' : group.net < 0 ? 'm-out' : 'm-zero'}`}>
        {money(group.net, 'always')}
      </span>
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════
   交易 · 紧凑表格 + 右侧面板
   表格负责扫读和批量，面板负责单笔细节和连续修改。
   两者靠同一套列宽协商：面板开着的时候，账户列让位给面板，
   因为账户在面板里写得更全；面板收起，列补回来，批量条改从底部升起。
   ══════════════════════════════════════════════════════════════ */

function TxTable({ D }) {
  const view = useTxView(D, 40)
  const [groupBy, setGroupBy] = useTxS('day')
  const [pane, setPane] = useTxS(true)
  const [focus, setFocus] = useTxS(D.tx[0].id)
  const stats = useTxM(() => txStats(view.rows), [view.rows])

  const visible = useTxM(() => view.rows.slice(0, view.shown), [view.rows, view.shown])

  const sections = useTxM(() => {
    if (groupBy === 'day') return groupByDay(visible).map((g) => ({ key: g.day, head: g, rows: g.rows, kind: 'day' }))
    const map = new Map()
    for (const t of visible) {
      const key = groupBy === 'cat' ? (t.cat ?? '未分类') : fundingOf(t)
      const bucket = map.get(key) ?? { key, rows: [], net: 0 }
      bucket.rows.push(t)
      bucket.net = Math.round((bucket.net + signed(t)) * 100) / 100
      map.set(key, bucket)
    }
    return [...map.values()]
      .sort((a, b) => b.rows.length - a.rows.length)
      .map((bucket) => ({ key: bucket.key, head: bucket, rows: bucket.rows, kind: 'plain' }))
  }, [visible, groupBy])

  // 键盘走位要按「屏幕上从上到下」的顺序，所以按分组后的顺序拍平，不是按原数组
  const order = useTxM(() => sections.flatMap((s) => s.rows.map((t) => t.id)), [sections])
  const current = useTxM(() => D.tx.find((t) => t.id === focus) ?? null, [D, focus])
  const multi = view.selected.size > 0
  const showAcct = !pane // 面板占走 320px，账户列让位；面板收起就补回来

  const step = useTxC((delta) => {
    setFocus((id) => {
      const index = order.indexOf(id)
      if (index === -1) return order[0] ?? id
      return order[Math.min(order.length - 1, Math.max(0, index + delta))] ?? id
    })
  }, [order])

  // ↑↓ 走位、空格勾选、Esc 清空——一次归几十笔分类时不用手离键盘
  useTxE(() => {
    const onKey = (e) => {
      const tag = e.target.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); step(1) }
      else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); step(-1) }
      else if (e.key === ' ') { e.preventDefault(); view.toggle(focus) }
      else if (e.key === 'Escape') view.setSelected(new Set())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step, focus, view.toggle, view.setSelected])

  // 走位走出可视区就跟着滚，表头是 sticky 的，用 block:'nearest' 不会跳
  useTxE(() => {
    document.querySelector(`[data-txid="${focus}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [focus])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="sec-h">
        <h1 className="sec-t" style={{ fontSize: 17 }}>交易</h1>
        <span className="sec-note num">{D.period.start} ~ {mmdd(D.period.end)}</span>
      </div>

      <VariantNote>
        表格负责扫读和批量，右侧面板负责单笔细节和连续修改——选一笔是详情加快捷编辑，
        选多笔就变批量面板，整理那 {D.uncategorized} 笔未分类不用来回开关弹窗。
        列表里用 <b>↑↓</b> 走位、<b>空格</b> 勾选、<b>Esc</b> 清空。
        面板开着时账户列让位（账户在面板里写得更全），面板收起就补回来、批量条改从底部升起。
      </VariantNote>

      <TxTabs tab={view.tab} setTab={view.setTab} counts={view.counts} />
      <StatStrip stats={stats} />
      <FilterBar
        keyword={view.keyword}
        setKeyword={view.setKeyword}
        active={view.keyword ? [{ key: 'q', label: `关键词：${view.keyword}` }] : []}
        onRemove={() => view.setKeyword('')}
        onClear={() => view.setKeyword('')}
        extra={(
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
            <span className="tweaks-label">分组</span>
            <Seg
              label="分组依据"
              value={groupBy}
              onChange={setGroupBy}
              options={[{ value: 'day', label: '按日' }, { value: 'cat', label: '按分类' }, { value: 'acct', label: '按账户' }]}
            />
            <button type="button" className="btn btn-ghost btn-sm" aria-pressed={pane} onClick={() => setPane((v) => !v)}>
              <Ic name={pane ? 'x' : 'rows'} size={13} />
              {pane ? '收起面板' : '展开面板'}
            </button>
          </span>
        )}
      />

      <UncatTip rows={view.rows} />

      <div
        style={{
          display: 'grid', gap: 12, alignItems: 'start',
          gridTemplateColumns: pane ? 'minmax(0, 1fr) 320px' : 'minmax(0, 1fr)',
        }}
      >
        <div className="card" style={{ padding: 6 }}>
          {/* 表头常驻：列有名字，金额才对得齐 */}
          <div
            className="tx-row"
            style={{
              position: 'sticky', top: 0, zIndex: 5, minHeight: 30, fontSize: 11,
              color: 'var(--text-secondary)', background: 'var(--surface-1)',
              borderRadius: 0,
              // 钉住之后底下要有一道影，否则和滚过去的行糊在一起，像渲染错位
              boxShadow: '0 1px 0 var(--border-subtle), 0 6px 8px -8px rgba(15, 23, 42, .45)',
            }}
          >
            <input type="checkbox" className="cb" aria-label="全选" />
            {groupBy !== 'day' && <span style={{ width: 46 }}>日期</span>}
            <span style={{ flex: 1, minWidth: 0 }}>描述</span>
            <span style={{ width: 150 }}>对手方</span>
            <span style={{ width: 92 }}>分类</span>
            {showAcct && <span style={{ width: 108 }}>账户</span>}
            <span style={{ width: 96, textAlign: 'right' }}>金额</span>
          </div>

          {sections.map((section) => (
            <div key={section.key}>
              {section.kind === 'day' ? (
                <DayHead group={section.head} D={D} />
              ) : (
                <div className="tx-day">
                  <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <b>{section.key}</b>
                    <span className="num" style={{ color: 'var(--text-tertiary)' }}>{section.rows.length} 笔</span>
                  </span>
                  <span className={`num ${section.head.net > 0 ? 'm-in' : 'm-out'}`}>{money(section.head.net, 'always')}</span>
                </div>
              )}
              {section.rows.map((t) => (
                <RowTable
                  key={t.id}
                  t={t}
                  showDate={groupBy !== 'day'}
                  showAcct={showAcct}
                  focused={pane && focus === t.id}
                  selected={view.selected.has(t.id)}
                  onFocus={() => setFocus(t.id)}
                  onToggle={() => view.toggle(t.id)}
                />
              ))}
            </div>
          ))}
          <ScrollTail shown={Math.min(view.shown, view.rows.length)} total={view.rows.length} onMore={() => view.setShown((n) => n + 40)} />
        </div>

        {pane && (
          <aside className="detail-pane" style={{ top: 12 }}>
            {multi ? (
              <BatchPane view={view} />
            ) : current ? (
              <DetailPane t={current} onPrev={() => step(-1)} onNext={() => step(1)} onSelect={() => view.toggle(current.id)} />
            ) : (
              <div className="card empty">选一笔看详情</div>
            )}
          </aside>
        )}
      </div>

      {/* 面板收起时，批量动作回到底部条 */}
      {!pane && multi && (
        <BulkBar count={view.selected.size} onClear={() => view.setSelected(new Set())} onOpenPane={() => setPane(true)} />
      )}
    </div>
  )
}

function RowTable({ t, showDate, showAcct, focused, selected, onFocus, onToggle }) {
  return (
    <div
      className="tx-row"
      data-txid={t.id}
      aria-selected={selected || undefined}
      style={focused && !selected ? { background: 'var(--surface-selected)' } : undefined}
      onClick={onFocus}
    >
      <input
        type="checkbox"
        className="cb"
        checked={selected}
        onChange={onToggle}
        onClick={(e) => e.stopPropagation()}
        aria-label={`选择 ${t.desc}`}
      />
      {showDate && <span className="num" style={{ width: 46, fontSize: 11.5, color: 'var(--text-secondary)' }}>{mmdd(t.date)}</span>}
      <span className="truncate" style={{ flex: 1, minWidth: 0, fontSize: 12.5 }}>{t.desc}</span>
      <span className="truncate tx-flow" style={{ width: 150 }}>{counterOf(t)}</span>
      <span style={{ width: 92 }}><CatCell cat={t.cat} /></span>
      {showAcct && <span className="truncate tx-flow" style={{ width: 108 }}>{fundingOf(t)}</span>}
      <span className={`num tx-amt ${amtClass(t.type)}`} style={{ width: 96 }}>{amountText(t)}</span>
    </div>
  )
}

/** 单笔：详情 + 快捷编辑。「保存并看下一笔」是为连续归类准备的 */
function DetailPane({ t, onPrev, onNext, onSelect }) {
  return (
    <div className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span className="figure-cap" style={{ flex: 1 }}>单笔详情</span>
        <button type="button" className="btn btn-ghost btn-xs" onClick={onPrev} aria-label="上一笔"><Ic name="arrowUp" size={13} /></button>
        <button type="button" className="btn btn-ghost btn-xs" onClick={onNext} aria-label="下一笔"><Ic name="arrowDown" size={13} /></button>
        <button type="button" className="btn btn-ghost btn-xs" onClick={onSelect}>勾选</button>
      </div>
      <div>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{t.desc}</div>
        <div className={`num figure-m ${amtClass(t.type)}`}>{amountText(t)}</div>
      </div>
      <hr className="hr" />
      <dl className="kv">
        <dt>日期</dt><dd className="num">{t.date} {dayOfWeek(t.date)}</dd>
        <dt>类型</dt><dd>{t.type === 'in' ? '收入' : t.type === 'out' ? '支出' : '转账'}</dd>
        <dt>来源</dt><dd className="truncate">{t.from}</dd>
        <dt>去向</dt><dd className="truncate">{t.to}</dd>
      </dl>
      <hr className="hr" />
      <label className="field-l">分类
        <input className="inp" defaultValue={t.cat ?? ''} placeholder="还没分类" key={t.id} />
      </label>
      <label className="field-l">标签
        <input className="inp" defaultValue={t.tags.join('、')} key={`${t.id}-t`} />
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn btn-primary btn-sm" style={{ flex: 1 }} onClick={onNext}>
          保存并看下一笔
        </button>
        <button type="button" className="btn btn-secondary btn-sm" aria-label="删除"><Ic name="trash" size={13} /></button>
      </div>
      <p style={{ margin: 0, fontSize: 11, color: 'var(--text-tertiary)' }}>
        ↑↓ 走位，空格勾选。归类可以一直按下去，不用回列表。
      </p>
    </div>
  )
}

/** 多笔：面板变批量表单，比底部条能装更多字段 */
function BatchPane({ view }) {
  return (
    <div className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <SectionHead title={`已选 ${view.selected.size} 笔`} />
      <label className="field-l">改分类<input className="inp" placeholder="输入或选择分类" /></label>
      <label className="field-l">改预算<select className="inp"><option>不使用预算</option></select></label>
      <label className="field-l">加标签<input className="inp" placeholder="逗号分隔" /></label>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn btn-primary btn-sm" style={{ flex: 1 }}>
          写进这 {view.selected.size} 笔
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => view.setSelected(new Set())}>取消</button>
      </div>
      <hr className="hr" />
      <button type="button" className="btn btn-secondary btn-sm"><Ic name="trash" size={13} />删除这 {view.selected.size} 笔</button>
      <p style={{ margin: 0, fontSize: 11, color: 'var(--text-tertiary)' }}>批量修改不可撤销，写之前先看清选中了哪些。</p>
    </div>
  )
}

Object.assign(window, { TxTable })
