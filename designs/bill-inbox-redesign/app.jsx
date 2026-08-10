/* App：状态全在这一层。行的状态迁移（入账／忽略／改判）、筛选、选择、
   分页、键盘层、变体开关都从这里往下传。 */

const { useState, useEffect, useMemo, useCallback, useRef } = React

const VIEWS = [
  { key: 'importable', label: '待入账' },
  { key: 'attention', label: '待确认' },
  { key: 'dismissed', label: '已忽略' },
  { key: 'imported', label: '已入账' },
]

const ATTENTION_SECTIONS = [
  { kind: 'transfer', label: '疑似转账', hint: '确认后记成账户之间的转账，不计入收支。' },
  { kind: 'duplicate', label: '疑似重复', hint: '和队列里另一笔金额、商户、日期都对得上。' },
  { kind: 'split', label: '需拆分', hint: '一笔付款里含多件商品，拆开才好归类。' },
  { kind: 'note', label: '需补备注', hint: '看不出这笔钱去哪了，补一句以后才查得回来。' },
]

function App() {
  /* 每行当前落在哪个 tab 里；初始值来自数据的 group */
  const [statuses, setStatuses] = useState(() => {
    const init = {}
    for (const row of ROWS) init[row.id] = row.group
    return init
  })

  const [view, setView] = useState('importable')
  const [channel, setChannel] = useState(null)
  const [mail, setMail] = useState(null)
  const [selected, setSelected] = useState(() => new Set())
  const [anchor, setAnchor] = useState(null)
  const [cursor, setCursor] = useState(0)
  const [expanded, setExpanded] = useState(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [shown, setShown] = useState(20)
  const [openBatches, setOpenBatches] = useState(() => new Set(['m1', 'm2']))
  const [panelCollapsed, setPanelCollapsed] = useState(false)
  const [toasts, setToasts] = useState([])
  const [tweaksOpen, setTweaksOpen] = useState(false)
  /* 定稿的一组：A 单行 + 滚动加载 + 顶部渠道条 + 紧凑。Tweaks 里仍可切回其它版本比对。 */
  const [tw, setTw] = useState({ shape: 'a', paging: 'scroll', panel: 'bar', density: 'compact', theme: 'light' })
  const [handled, setHandled] = useState(0)
  const stickRef = useRef(null)

  const setT = useCallback((patch) => setTw((prev) => ({ ...prev, ...patch })), [])

  useEffect(() => {
    document.documentElement.dataset.theme = tw.theme
    document.documentElement.dataset.density = tw.density
  }, [tw.theme, tw.density])

  /* 顶部条钉在视口顶端，日期分组头要贴着它的下沿吸附 ——
     条子的高度会随「选中渠道后多出一行邮件 chip」变化，量出来写进 --stick-h。 */
  useEffect(() => {
    const el = stickRef.current
    if (!el) return
    const write = () => document.documentElement.style.setProperty('--stick-h', `${Math.round(el.offsetHeight)}px`)
    write()
    const ro = new ResizeObserver(write)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /* ── 派生数据 ────────────────────────────────────────── */

  const rowsWithStatus = useMemo(() => ROWS.map((r) => ({ ...r, status: statuses[r.id] })), [statuses])

  const inView = useMemo(() => rowsWithStatus.filter((r) => r.status === view), [rowsWithStatus, view])

  const rows = useMemo(() => {
    let list = inView
    if (mail) list = list.filter((r) => r.mail === mail)
    else if (channel) list = list.filter((r) => (mailOf(r.mail) || {}).channel === channel)
    return list
  }, [inView, channel, mail])

  const counts = useMemo(() => {
    const out = {}
    for (const c of CHANNELS) {
      out[c.key] = rowsWithStatus.filter(
        (r) => r.status === view && (mailOf(r.mail) || {}).channel === c.key,
      ).length
    }
    return out
  }, [rowsWithStatus, view])

  const tabCounts = useMemo(() => {
    const out = {}
    for (const v of VIEWS) out[v.key] = rowsWithStatus.filter((r) => r.status === v.key).length
    return out
  }, [rowsWithStatus])

  const totalWork = ROWS.filter((r) => r.group === 'importable').length

  /* 换 tab / 换筛选后，之前的选中和光标已经不在屏幕上了 */
  useEffect(() => {
    setSelected(new Set())
    setAnchor(null)
    setExpanded(null)
    setCursor(0)
    setPage(1)
    setShown(pageSize)
  }, [view, channel, mail, pageSize])

  /* ── 当前屏上的行（分页／滚动／批次三种切法）───────────── */

  const visible = useMemo(() => {
    if (view === 'attention') return rows
    if (tw.paging === 'pager') return rows.slice((page - 1) * pageSize, page * pageSize)
    if (tw.paging === 'scroll') return rows.slice(0, shown)
    return rows
  }, [rows, view, tw.paging, page, pageSize, shown])

  const allSelected = visible.length > 0 && visible.every((r) => selected.has(r.id))
  const someSelected = visible.some((r) => selected.has(r.id))
  const selectedRows = rowsWithStatus.filter((r) => selected.has(r.id))

  /* ── 动作 ────────────────────────────────────────────── */

  const toast = useCallback((message, opts = {}) => {
    const id = `t${Date.now()}${Math.random().toString(36).slice(2, 6)}`
    setToasts((prev) => [...prev, { id, message, kind: opts.kind || 'success', undo: opts.undo }])
    window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), opts.undo ? 7000 : 3600)
  }, [])

  const move = useCallback((ids, next, message) => {
    if (ids.length === 0) return
    const prev = {}
    setStatuses((cur) => {
      const out = { ...cur }
      for (const id of ids) { prev[id] = cur[id]; out[id] = next }
      return out
    })
    setSelected(new Set())
    if (next === 'imported' || next === 'dismissed') setHandled((n) => n + ids.length)
    toast(message, { undo: { ids, prev } })
  }, [toast])

  const undo = useCallback((t) => {
    if (!t.undo) return
    setStatuses((cur) => ({ ...cur, ...t.undo.prev }))
    setHandled((n) => Math.max(0, n - t.undo.ids.length))
    setToasts((prev) => prev.filter((x) => x.id !== t.id))
    toast(`已撤销，${t.undo.ids.length} 笔回到原处`)
  }, [toast])

  const rowAction = useCallback((row, kind) => {
    if (kind === 'import') move([row.id], 'imported', `已入账 ${row.merchant} ¥${fmtAmount(row.amount)}`)
    else if (kind === 'dismiss') move([row.id], 'dismissed', `已忽略 ${row.merchant}`)
    else if (kind === 'restore') move([row.id], 'importable', `已恢复 ${row.merchant}`)
    else if (kind === 'confirm-transfer') move([row.id], 'importable', `已确认为转账：${row.account} → ${row.to}`)
    else if (kind === 'not-duplicate') move([row.id], 'importable', '已标记为「不是重复」')
    else if (kind === 'split') toast('拆分面板会在这里打开（原型未实现）', { kind: 'error' })
  }, [move, toast])

  const toggleSelect = useCallback((row, index, shift) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (shift && anchor !== null) {
        const [from, to] = anchor <= index ? [anchor, index] : [index, anchor]
        for (let i = from; i <= to; i += 1) if (visible[i]) next.add(visible[i].id)
        return next
      }
      if (next.has(row.id)) next.delete(row.id)
      else next.add(row.id)
      return next
    })
    setAnchor(index)
  }, [anchor, visible])

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      if (visible.every((r) => prev.has(r.id))) {
        const next = new Set(prev)
        visible.forEach((r) => next.delete(r.id))
        return next
      }
      const next = new Set(prev)
      visible.forEach((r) => next.add(r.id))
      return next
    })
  }, [visible])

  /* ── 键盘层 ──────────────────────────────────────────── */

  useEffect(() => {
    function onKey(e) {
      const el = e.target
      if (el instanceof HTMLElement) {
        const tag = el.tagName.toLowerCase()
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable) return
      }
      if (e.metaKey || e.ctrlKey || e.altKey || visible.length === 0) return
      const i = Math.min(cursor, visible.length - 1)
      const row = visible[i]
      if (!row) return
      if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); setCursor(Math.min(i + 1, visible.length - 1)) }
      else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); setCursor(Math.max(i - 1, 0)) }
      else if (e.key === 'x') { e.preventDefault(); toggleSelect(row, i, false) }
      else if (e.key === 'e') { e.preventDefault(); setExpanded((cur) => (cur === row.id ? null : row.id)) }
      else if (e.key === 'd') { e.preventDefault(); rowAction(row, 'dismiss') }
      else if (e.key === 'Enter') {
        e.preventDefault()
        const ids = selected.size > 0 ? Array.from(selected) : [row.id]
        move(ids, 'imported', `已入账 ${ids.length} 笔`)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, cursor, selected, toggleSelect, rowAction, move])

  useEffect(() => {
    const row = visible[cursor]
    if (row) document.getElementById(`row-${row.id}`)?.scrollIntoView({ block: 'nearest' })
  }, [cursor, visible])

  /* ── 渲染一行（含展开区）────────────────────────────── */

  function renderRow(row, index) {
    return (
      <div key={row.id} id={`row-${row.id}`}>
        <QueueRow
          row={row}
          shape={tw.shape}
          view={view}
          selected={selected.has(row.id)}
          cursor={visible[cursor] && visible[cursor].id === row.id}
          expanded={expanded === row.id}
          onSelect={(shift) => toggleSelect(row, index, shift)}
          onCursor={() => setCursor(index)}
          onExpand={() => setExpanded(expanded === row.id ? null : row.id)}
          onAction={(kind) => rowAction(row, kind)}
        />
        {expanded === row.id && <RowDetail row={row} onAction={(kind) => rowAction(row, kind)} />}
      </div>
    )
  }

  /* ── 列表主体 ────────────────────────────────────────── */

  function renderList() {
    if (rows.length === 0) {
      return (
        <Empty
          message={
            view === 'importable' ? '这个范围里没有待入账的流水'
              : view === 'attention' ? '没有需要确认的流水'
                : view === 'dismissed' ? '还没有忽略过流水' : '还没有入账过流水'
          }
          actionLabel={channel || mail ? '看全部来源' : view === 'importable' ? '同步邮件' : '看待入账的'}
          onAction={() => {
            if (channel || mail) { setChannel(null); setMail(null) }
            else if (view !== 'importable') setView('importable')
            else toast('同步完成：未发现新的账单邮件')
          }}
        />
      )
    }

    /* 待确认：按「要你做的判断」分节，每节一句话说清楚在判断什么 */
    if (view === 'attention') {
      return ATTENTION_SECTIONS.map((section) => {
        const list = rows.filter((r) => r.kind === section.kind)
        if (list.length === 0) return null
        return (
          <section key={section.kind}>
            <div className="daygroup">
              <span className="d">{section.label}</span>
              <span className="num">{list.length} 笔</span>
              <span className="rel" style={{ marginLeft: 8 }}>{section.hint}</span>
            </div>
            {list.map((row) => renderRow(row, visible.indexOf(row)))}
          </section>
        )
      })
    }

    /* 按邮件批次折叠：一封邮件 = 一批，整批入账／整批全选 */
    if (tw.paging === 'batch') {
      return groupByMail(rows).map(({ mail: m, rows: list }) => (
        <BatchSection
          key={m.id}
          mail={m}
          rows={list}
          open={openBatches.has(m.id)}
          onToggle={() => setOpenBatches((prev) => {
            const next = new Set(prev)
            if (next.has(m.id)) next.delete(m.id)
            else next.add(m.id)
            return next
          })}
          onSelectBatch={() => setSelected((prev) => {
            const next = new Set(prev)
            list.forEach((r) => next.add(r.id))
            return next
          })}
          onImportBatch={() => move(list.map((r) => r.id), 'imported', `已入账「${m.subject}」解析出的 ${list.length} 笔`)}
        >
          {tw.shape === 'c' && <TableHead />}
          {list.map((row) => renderRow(row, visible.indexOf(row)))}
        </BatchSection>
      ))
    }

    /* 表格结构：日期回到列里，不再分组 */
    if (tw.shape === 'c') {
      return (
        <>
          <TableHead />
          {visible.map((row, i) => renderRow(row, i))}
        </>
      )
    }

    /* 单行／双行结构：粘性日期头 + 当日笔数与合计 */
    let index = -1
    return groupByDay(visible).map(({ date, rows: list }) => (
      <section key={date}>
        <DayHeader date={date} rows={list} />
        {list.map((row) => { index += 1; return renderRow(row, index) })}
      </section>
    ))
  }

  const filterLabel = mail ? (mailOf(mail) || {}).subject : channel ? (CHANNELS.find((c) => c.key === channel) || {}).label : null

  return (
    <div className="app">
      <nav className="nav">
        <div className="nav-brand"><b>abei</b><span lang="zh">阿贝</span></div>
        <a className="nav-item" href="#today">今天</a>
        <a className="nav-item" href="#inbox" aria-current="page">
          账单收件箱
          <span className="count num">{tabCounts.importable + tabCounts.attention}</span>
        </a>
        <a className="nav-item" href="#tx">交易</a>
        <a className="nav-item" href="#assistant">财务助手</a>
        <a className="nav-item" href="#accounts">账户</a>
        <a className="nav-item" href="#budgets">预算</a>
        <a className="nav-item" href="#analysis">分析</a>
        <a className="nav-item" href="#settings">设置</a>
      </nav>

      <main className="page" data-screen-label="账单收件箱">
        <header className="page-head">
          <div>
            <h1>账单收件箱</h1>
            <p>从邮箱账单解析出的流水；入账后进入交易。</p>
          </div>
          <div className="head-actions">
            <button className="btn" data-variant="secondary" onClick={() => toast('AI 已给出 18 笔建议（来自 3 封邮件）')}>
              <IconSparkle size={14} />让 AI 出建议
            </button>
            <button className="btn" data-variant="secondary" onClick={() => toast('同步完成：扫描 12，新建 2，处理 2')}>
              <IconSync size={14} />同步邮件
            </button>
            <button className="icon-btn" aria-label="邮箱设置"><IconGear size={16} /></button>
          </div>
        </header>

        {view === 'importable' && <Workload rows={rows} done={handled} total={totalWork} />}

        <div className="stickbar" ref={stickRef}>
          <div role="tablist" aria-label="流水状态" className="tabs">
            {VIEWS.map((v) => (
              <button
                key={v.key}
                role="tab"
                aria-selected={view === v.key}
                className="tab"
                onClick={() => setView(v.key)}
              >
                {v.label}
                <span className="n num">{tabCounts[v.key]}</span>
                {v.key === 'attention' && tabCounts.attention > 0 && <i className="dot" />}
              </button>
            ))}
          </div>

          {tw.panel === 'bar' && (
            <ChannelBar
              channels={CHANNELS}
              mails={MAILS}
              counts={counts}
              selectedChannel={channel}
              selectedMail={mail}
              onSelectChannel={(k) => { setChannel(k); setMail(null) }}
              onSelectMail={(id) => { setMail(id) }}
            />
          )}
        </div>

        <div className="body" data-panel={tw.panel === 'bar' ? 'off' : panelCollapsed ? 'collapsed' : 'open'}>
          {tw.panel === 'side' && (
            <SourceSidebar
              collapsed={panelCollapsed}
              onToggleCollapsed={() => setPanelCollapsed((v) => !v)}
              channels={CHANNELS}
              mails={MAILS}
              counts={counts}
              selectedChannel={channel}
              selectedMail={mail}
              onSelectChannel={(k) => { setChannel(k); setMail(null) }}
              onSelectMail={(id) => { setMail(id); setChannel(null) }}
              onUnlock={(m) => toast(`「${m.subject}」的解压密码框会在这里打开`, { kind: 'error' })}
            />
          )}

          <div className="card queue">
            <div className="queue-bar">
              {(view === 'importable' || view === 'attention') && (
                <input
                  type="checkbox"
                  aria-label="全选本页"
                  checked={allSelected}
                  ref={(el) => { if (el) el.indeterminate = !allSelected && someSelected }}
                  onChange={toggleAll}
                />
              )}
              <h2>{VIEWS.find((v) => v.key === view).label} <span className="num">{rows.length}</span> 笔</h2>
              {filterLabel && (
                <span className="filter-note">
                  只看：{filterLabel}
                  <button onClick={() => { setChannel(null); setMail(null) }}>看全部</button>
                </span>
              )}
              {view === 'importable' && (
                <span className="sub">其中 <span className="num">{rows.filter((r) => r.ai).length}</span> 笔带 AI 建议</span>
              )}
              <div className="right">
                {view === 'importable' && rows.length > 0 && (
                  <button
                    className="btn"
                    data-variant="primary"
                    onClick={() => move(rows.map((r) => r.id), 'imported', `已入账 ${rows.length} 笔`)}
                  >
                    <IconCheck size={14} />入账全部 {rows.length} 笔
                  </button>
                )}
              </div>
            </div>

            {renderList()}

            {view !== 'attention' && rows.length > 0 && tw.paging === 'pager' && (
              <Pager page={page} pageSize={pageSize} total={rows.length} onPage={setPage} onPageSize={setPageSize} />
            )}
            {view !== 'attention' && rows.length > 0 && tw.paging === 'scroll' && (
              <LoadMore shown={Math.min(shown, rows.length)} total={rows.length} onMore={() => setShown((n) => n + pageSize)} />
            )}
          </div>
        </div>
      </main>

      {selected.size > 0 && (
        <BulkBar
          rows={selectedRows}
          onImport={() => move(Array.from(selected), 'imported', `已入账 ${selected.size} 笔`)}
          onDismiss={() => move(Array.from(selected), 'dismissed', `已忽略 ${selected.size} 笔`)}
          onClear={() => setSelected(new Set())}
        />
      )}

      <Toasts items={toasts} onUndo={undo} />
      <Tweaks open={tweaksOpen} onToggle={() => setTweaksOpen((v) => !v)} state={tw} set={setT} />
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />)
