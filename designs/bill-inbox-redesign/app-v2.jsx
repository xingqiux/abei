/* App v2：状态全在这一层。
   与 v1 的根本区别：没有四个平级 tab，页面只有两层（待处理 / 已完成）
   加一条管道叙事；所有数字都从同一份 rows 派生，永远加得平。 */

const { useState, useEffect, useMemo, useCallback, useRef } = React

function App() {
  /* 每行的可变部分（state / kind / reason），初始取自数据 */
  const [overrides, setOverrides] = useState({})
  const [mailStates, setMailStates] = useState({})

  const [layer, setLayer] = useState('todo')
  const [source, setSource] = useState(null)
  const [mailFilter, setMailFilter] = useState(null)
  const [doneFilter, setDoneFilter] = useState('all')
  const [ledgerOpen, setLedgerOpen] = useState(false)
  const [attnOpen, setAttnOpen] = useState(false)
  const [unlock, setUnlockState] = useState({})

  const [selected, setSelected] = useState(() => new Set())
  const [anchor, setAnchor] = useState(null)
  const [cursor, setCursor] = useState(0)
  const [expanded, setExpanded] = useState(null)
  const [shown, setShown] = useState(40)
  const [toasts, setToasts] = useState([])
  const [tweaksOpen, setTweaksOpen] = useState(false)
  const [tw, setTw] = useState({ pipe: 'line', attn: 'collapsed', prov: 'detail', density: 'compact', theme: 'light' })
  const stickRef = useRef(null)

  const setT = useCallback((patch) => setTw((prev) => ({ ...prev, ...patch })), [])
  const setUnlock = useCallback((id, patch) => setUnlockState((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), ...patch } })), [])

  useEffect(() => {
    document.documentElement.dataset.theme = tw.theme
    document.documentElement.dataset.density = tw.density
  }, [tw.theme, tw.density])

  useEffect(() => { setAttnOpen(tw.attn === 'open') }, [tw.attn])

  /* 顶部条吸顶，日期分组头贴着它的下沿；高度量出来写进 --stick-h */
  useEffect(() => {
    const el = stickRef.current
    if (!el) return
    const write = () => document.documentElement.style.setProperty('--stick-h', `${Math.round(el.offsetHeight)}px`)
    write()
    const ro = new ResizeObserver(write)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /* ── 派生数据：一切数字的唯一来源 ───────────────────── */

  const rows = useMemo(
    () => ROWS2.map((r) => (overrides[r.id] ? { ...r, ...overrides[r.id] } : r)),
    [overrides],
  )
  const mails = useMemo(
    () => MAILS.map((m) => (mailStates[m.id] ? { ...m, state: mailStates[m.id] } : m)),
    [mailStates],
  )

  const scoped = useMemo(() => {
    let list = rows
    if (source) list = list.filter((r) => sourceOf(r) === source)
    if (mailFilter) list = list.filter((r) => r.mail === mailFilter)
    return list
  }, [rows, source, mailFilter])

  const importableRows = useMemo(() => scoped.filter((r) => r.state === 'importable'), [scoped])
  const attentionRows = useMemo(() => scoped.filter((r) => r.state === 'attention'), [scoped])
  const todoRows = importableRows.length + attentionRows.length

  const doneCounts = useMemo(() => {
    const done = scoped.filter((r) => r.state === 'imported' || r.state === 'dismissed')
    const by = (reason) => done.filter((r) => r.state === 'dismissed' && r.reason === reason).length
    return {
      all: done.length,
      imported: done.filter((r) => r.state === 'imported').length,
      user: by('user'), dup_auto: by('dup_auto'), zero: by('zero'), archived: by('archived'),
    }
  }, [scoped])

  const doneRows = useMemo(() => {
    const done = scoped.filter((r) => r.state === 'imported' || r.state === 'dismissed')
    if (doneFilter === 'all') return done
    if (doneFilter === 'imported') return done.filter((r) => r.state === 'imported')
    if (doneFilter === 'system') return done.filter((r) => r.state === 'dismissed' && r.reason !== 'user')
    if (doneFilter === 'byyou') return done.filter((r) => r.state === 'imported' || (r.state === 'dismissed' && r.reason === 'user'))
    return done.filter((r) => r.state === 'dismissed' && r.reason === doneFilter)
  }, [scoped, doneFilter])

  /* 来源 chip 的数字：该来源剩多少笔待处理。全局口径，不随选中变。 */
  const todoBySource = useMemo(() => {
    const out = {}
    for (const c of CHANNELS) {
      out[c.key] = rows.filter(
        (r) => (r.state === 'importable' || r.state === 'attention') && sourceOf(r) === c.key,
      ).length
    }
    return out
  }, [rows])
  const todoAll = useMemo(
    () => rows.filter((r) => r.state === 'importable' || r.state === 'attention').length,
    [rows],
  )

  const scopedMails = useMemo(
    () => (source ? mails.filter((m) => m.channel === source) : mails),
    [mails, source],
  )
  const lockedN = scopedMails.filter((m) => m.state === 'locked').length
  const failedN = scopedMails.filter((m) => m.state === 'failed').length

  /* 管道叙事的五个数：邮件 → 解析 → 系统 → 你已处理 → 待你处理 */
  const pipeStats = useMemo(() => {
    const auto = scoped.filter((r) => r.state === 'dismissed' && r.reason !== 'user').length
    const byYou = scoped.filter((r) => r.state === 'imported' || (r.state === 'dismissed' && r.reason === 'user')).length
    return {
      mails: source ? (channelOf(source) || {}).mailTotal : MAIL_TOTAL,
      parsed: scoped.length,
      auto, byYou,
      todo: todoRows,
      attention: attentionRows.length,
    }
  }, [scoped, source, todoRows, attentionRows])

  /* 邮件清单里每封的进度 */
  const mailStats = useMemo(() => {
    const out = {}
    for (const r of rows) {
      const s = out[r.mail] || (out[r.mail] = { total: 0, todo: 0 })
      s.total += 1
      if (r.state === 'importable' || r.state === 'attention') s.todo += 1
    }
    return out
  }, [rows])

  /* 换层 / 换筛选后，选中、光标、展开、加载量全部复位 */
  useEffect(() => {
    setSelected(new Set())
    setAnchor(null)
    setExpanded(null)
    setCursor(0)
    setShown(40)
  }, [layer, source, mailFilter, doneFilter])

  /* ── 当前屏上按 DOM 顺序排的可操作行（键盘层要用）────── */

  const importableVisible = useMemo(() => importableRows.slice(0, shown), [importableRows, shown])
  const doneVisible = useMemo(() => doneRows.slice(0, shown), [doneRows, shown])
  const visible = useMemo(() => {
    if (layer === 'done') return doneVisible
    const attn = attnOpen
      ? JUDGE_SECTIONS.flatMap((s) => attentionRows.filter((r) => r.kind === s.kind))
      : []
    return attn.concat(importableVisible)
  }, [layer, doneVisible, attnOpen, attentionRows, importableVisible])

  const allSelected = importableVisible.length > 0 && importableVisible.every((r) => selected.has(r.id))
  const someSelected = importableVisible.some((r) => selected.has(r.id))
  const selectedRows = rows.filter((r) => selected.has(r.id))

  /* ── 动作 ────────────────────────────────────────────── */

  const toast = useCallback((message, opts = {}) => {
    const id = `t${Date.now()}${Math.random().toString(36).slice(2, 6)}`
    setToasts((prev) => [...prev, { id, message, kind: opts.kind || 'success', undo: opts.undo }])
    window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), opts.undo ? 7000 : 3600)
  }, [])

  const patchRows = useCallback((ids, patch, message) => {
    if (ids.length === 0) return
    const prev = {}
    setOverrides((cur) => {
      const out = { ...cur }
      for (const id of ids) {
        prev[id] = cur[id] || null
        out[id] = { ...(cur[id] || {}), ...patch }
      }
      return out
    })
    setSelected(new Set())
    toast(message, { undo: { ids, prev } })
  }, [toast])

  const undo = useCallback((t) => {
    if (!t.undo) return
    setOverrides((cur) => {
      const out = { ...cur }
      for (const id of t.undo.ids) {
        if (t.undo.prev[id]) out[id] = t.undo.prev[id]
        else delete out[id]
      }
      return out
    })
    setToasts((prev) => prev.filter((x) => x.id !== t.id))
    toast(`已撤销，${t.undo.ids.length} 笔回到原处`)
  }, [toast])

  const rowAction = useCallback((row, kind) => {
    if (kind === 'import') patchRows([row.id], { state: 'imported' }, `已入账 ${row.merchant} ¥${fmtAmount(row.amount)}`)
    else if (kind === 'dismiss') patchRows([row.id], { state: 'dismissed', reason: 'user' }, `已忽略 ${row.merchant}`)
    else if (kind === 'restore') patchRows([row.id], { state: 'importable', reason: null }, `已恢复 ${row.merchant}，回到待处理`)
    else if (kind === 'confirm-transfer') patchRows([row.id], { state: 'importable', kind: null, dir: '转账' }, '已确认为转账，回到可直接入账')
    else if (kind === 'not-transfer') patchRows([row.id], { state: 'importable', kind: null }, '已按普通收支处理，回到可直接入账')
    else if (kind === 'confirm-duplicate') patchRows([row.id], { state: 'dismissed', reason: 'dup_auto' }, '已确认合并，收进「已完成 · 合并的重复」')
    else if (kind === 'not-duplicate') patchRows([row.id], { state: 'importable', kind: null, dupMails: null }, '已标记「不是重复」，回到可直接入账')
    else if (kind === 'split') toast('拆分面板会在这里打开（原型未实现）', { kind: 'error' })
  }, [patchRows, toast])

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
      if (importableVisible.every((r) => prev.has(r.id))) {
        const next = new Set(prev)
        importableVisible.forEach((r) => next.delete(r.id))
        return next
      }
      const next = new Set(prev)
      importableVisible.forEach((r) => next.add(r.id))
      return next
    })
  }, [importableVisible])

  /* 解锁：两步确认，密码不出本机 —— 跟真实链路一致 */
  const onUnlockPreview = useCallback((m) => {
    setUnlock(m.id, { previewed: true })
    toast('密码校验通过（未离开本机）：预览到 41 笔流水')
  }, [setUnlock, toast])
  const onUnlockConfirm = useCallback((m) => {
    setMailStates((prev) => ({ ...prev, [m.id]: 'ok' }))
    toast(`「${m.subject}」开始解析，完成后流水会进入待处理（原型不模拟新增行）`)
  }, [toast])
  const onRetry = useCallback((m) => {
    toast(`「${m.subject}」已重新排队解析（原型示意）`)
  }, [toast])

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
        const ids = selected.size > 0
          ? Array.from(selected)
          : (row.state === 'importable' ? [row.id] : [])
        if (ids.length > 0) patchRows(ids, { state: 'imported' }, `已入账 ${ids.length} 笔`)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, cursor, selected, toggleSelect, rowAction, patchRows])

  useEffect(() => {
    const row = visible[cursor]
    if (row) document.getElementById(`row-${row.id}`)?.scrollIntoView({ block: 'nearest' })
  }, [cursor, visible])

  /* ── 渲染 ────────────────────────────────────────────── */

  function renderRow(row) {
    const index = visible.indexOf(row)
    return (
      <div key={row.id} id={`row-${row.id}`}>
        <QRow
          row={row}
          prov={tw.prov === 'inline'}
          selected={selected.has(row.id)}
          cursor={visible[cursor] && visible[cursor].id === row.id}
          expanded={expanded === row.id}
          onSelect={(shift) => toggleSelect(row, index, shift)}
          onCursor={() => setCursor(index)}
          onExpand={() => setExpanded(expanded === row.id ? null : row.id)}
          onAction={(kind) => rowAction(row, kind)}
        />
        {expanded === row.id && <QDetail row={row} onAction={(kind) => rowAction(row, kind)} />}
      </div>
    )
  }

  const srcMeta = source ? channelOf(source) : null
  const mailMeta = mailFilter ? mailOf(mailFilter) : null

  /* 待处理层为空时要能解释自己 —— 微信那种「行上全是微信图标、
     来源里却是 0」的困惑，就死在这个空态上 */
  function renderTodoEmpty() {
    if (srcMeta) {
      const doneOfSource = rows.filter((r) => sourceOf(r) === source && (r.state === 'imported' || r.state === 'dismissed'))
      const imported = doneOfSource.filter((r) => r.state === 'imported').length
      const rest = doneOfSource.length - imported
      return (
        <Empty
          message={`${srcMeta.label}来源没有待处理的流水`}
          why={`该来源共解析出 ${doneOfSource.length} 笔，已入账 ${imported} · 忽略/清理 ${rest}，都处理完了。列表行首的${srcMeta.label === '微信支付' ? '微信' : ''}图标是「支付方式」，和这里按邮件来源筛选是两回事。`}
          actions={[
            { label: '看它的已完成记录', primary: true, onClick: () => { setLayer('done'); setDoneFilter('all') } },
            { label: '看全部来源', onClick: () => setSource(null) },
          ]}
        />
      )
    }
    return (
      <Empty
        message="待处理清零了"
        why="新账单邮件到达后会自动同步；也可以现在手动同步一次。"
        actions={[{ label: '同步邮件', primary: true, onClick: () => toast('同步完成：扫描 12 封，没有新的账单邮件') }]}
      />
    )
  }

  const doneHint = {
    dup_auto: '同一渠道两封邮件里的同一笔交易会自动合并，这里是合并记录；误合并可以恢复。',
    zero: '解析时金额为零的行（如红包、冲正）会自动清理，不打扰你。',
    archived: '整封邮件被归档时，它名下没处理的行会一起收进来。',
    system: '这些是系统自动处理的记录：合并重复、清理零元行、随邮件归档。误处理的都能恢复。',
    byyou: '这些是你处理过的：手动入账的和手动忽略的。',
  }[doneFilter]

  return (
    <div className="app">
      <nav className="nav">
        <div className="nav-brand"><b>abei</b><span lang="zh">阿贝</span></div>
        <a className="nav-item" href="#today">今天</a>
        <a className="nav-item" href="#inbox" aria-current="page">
          账单收件箱
          <span className="count num" title={lockedN + failedN > 0 ? `待处理 ${todoAll} 笔；另有 ${lockedN + failedN} 封邮件卡住` : `待处理 ${todoAll} 笔`}>
            {todoAll}
          </span>
        </a>
        <a className="nav-item" href="#tx">交易</a>
        <a className="nav-item" href="#assistant">财务助手</a>
        <a className="nav-item" href="#accounts">账户</a>
        <a className="nav-item" href="#budgets">预算</a>
        <a className="nav-item" href="#analysis">分析</a>
        <a className="nav-item" href="#settings">设置</a>
      </nav>

      <main className="page" data-screen-label="账单收件箱 v2">
        <header className="page-head">
          <div>
            <h1>账单收件箱</h1>
            <p>从你绑定的邮箱同步账单邮件，解析成流水；确认后进入交易。</p>
          </div>
          <div className="head-actions">
            <button className="btn" data-variant="secondary" onClick={() => toast('AI 已给出 18 笔建议（虚线框的分类）')}>
              <IconSparkle size={14} />让 AI 出建议
            </button>
            <button className="btn" data-variant="secondary" onClick={() => toast('同步完成：扫描 12 封，新增 0 封')}>
              <IconSync size={14} />同步邮件
            </button>
            <button className="icon-btn" aria-label="邮箱设置"><IconGear size={16} /></button>
          </div>
        </header>

        <section className="card pipe" data-screen-label="管道叙事">
          <PipeStrip
            variant={tw.pipe}
            stats={pipeStats}
            ledgerOpen={ledgerOpen}
            layer={layer}
            doneFilter={doneFilter}
            onOpenLedger={() => setLedgerOpen((v) => !v)}
            onGoDone={(f) => { setLayer('done'); setDoneFilter(f) }}
            onGoTodo={() => setLayer('todo')}
          />
          <PipeWarn locked={lockedN} failed={failedN} onOpenLedger={() => setLedgerOpen(true)} />
        </section>

        {ledgerOpen && (
          <MailLedger
            mails={scopedMails}
            mailStats={mailStats}
            selectedMail={mailFilter}
            onSelectMail={(id) => setMailFilter(id)}
            onClose={() => setLedgerOpen(false)}
            unlock={unlock}
            setUnlock={setUnlock}
            onUnlockPreview={onUnlockPreview}
            onUnlockConfirm={onUnlockConfirm}
            onRetry={onRetry}
            toast={toast}
          />
        )}

        <div className="stickbar" ref={stickRef}>
          <div className="stickline">
            <LayerSwitch
              layer={layer}
              todo={todoRows}
              attention={attentionRows.length}
              done={doneCounts.all}
              onLayer={setLayer}
            />
            <SourceLine
              todoBySource={todoBySource}
              todoTotal={todoAll}
              selected={source}
              onSelect={(k) => { setSource(k); setMailFilter(null) }}
            />
          </div>
        </div>

        <div className="body" data-panel="off">
          <div className="card queue">
            {layer === 'todo' ? (
              <>
                <div className="queue-bar">
                  <input
                    type="checkbox"
                    aria-label="全选可入账的"
                    checked={allSelected}
                    ref={(el) => { if (el) el.indeterminate = !allSelected && someSelected }}
                    onChange={toggleAll}
                  />
                  <h2>待处理 <span className="num">{todoRows}</span> 笔</h2>
                  <span className="sub">
                    可直接入账 <span className="num">{importableRows.length}</span>
                    {attentionRows.length > 0 && <> · 需你判断 <span className="num">{attentionRows.length}</span></>}
                  </span>
                  {mailMeta && (
                    <span className="filter-note">
                      只看邮件：{mailMeta.subject}
                      <button onClick={() => setMailFilter(null)}>看全部</button>
                    </span>
                  )}
                  <div className="right">
                    {importableRows.length > 0 && (
                      <button
                        className="btn"
                        data-variant="primary"
                        onClick={() => patchRows(importableRows.map((r) => r.id), { state: 'imported' }, `已入账 ${importableRows.length} 笔`)}
                      >
                        <IconCheck size={14} />入账 {importableRows.length} 笔
                      </button>
                    )}
                  </div>
                </div>

                {todoRows === 0 ? renderTodoEmpty() : (
                  <>
                    <AttentionBlock
                      rows={attentionRows}
                      open={attnOpen}
                      onToggle={() => setAttnOpen((v) => !v)}
                      renderRow={renderRow}
                    />
                    {importableRows.length > 0 && (
                      <div className="qsection">
                        <span className="d">可直接入账 <span className="num">{importableRows.length}</span> 笔</span>
                        <span className="hint">分类没问题就直接入账；虚线框是 AI 建议，入账即确认。</span>
                      </div>
                    )}
                    {groupByDay(importableVisible).map(({ date, rows: list }) => (
                      <section key={date}>
                        <DayHeader date={date} rows={list} />
                        {list.map(renderRow)}
                      </section>
                    ))}
                    {importableRows.length > 0 && (
                      <LoadMore
                        shown={Math.min(shown, importableRows.length)}
                        total={importableRows.length}
                        onMore={() => setShown((n) => n + 40)}
                      />
                    )}
                  </>
                )}
              </>
            ) : (
              <>
                <div className="queue-bar">
                  <h2>已完成 <span className="num">{doneCounts.all}</span> 笔记录</h2>
                  <span className="sub">
                    系统自动 <span className="num">{doneCounts.dup_auto + doneCounts.zero + doneCounts.archived}</span>
                    {' '}· 你处理的 <span className="num">{doneCounts.imported + doneCounts.user}</span>
                  </span>
                  {(doneFilter === 'system' || doneFilter === 'byyou') && (
                    <span className="filter-note">
                      只看：{doneFilter === 'system' ? '系统自动处理' : '你处理的'}
                      <button onClick={() => setDoneFilter('all')}>看全部</button>
                    </span>
                  )}
                </div>
                <DoneFilters counts={doneCounts} filter={doneFilter} onFilter={setDoneFilter} />
                {doneHint && <div className="hintline"><IconAlert size={13} />{doneHint}</div>}
                {doneRows.length === 0 ? (
                  <Empty message="这个范围里还没有记录" />
                ) : (
                  <>
                    {groupByDay(doneVisible).map(({ date, rows: list }) => (
                      <section key={date}>
                        <DayHeader date={date} rows={list} />
                        {list.map(renderRow)}
                      </section>
                    ))}
                    <LoadMore
                      shown={Math.min(shown, doneRows.length)}
                      total={doneRows.length}
                      onMore={() => setShown((n) => n + 40)}
                    />
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </main>

      {selectedRows.length > 0 && (
        <BulkBar
          rows={selectedRows}
          onImport={() => patchRows(selectedRows.filter((r) => r.state === 'importable').map((r) => r.id), { state: 'imported' }, `已入账 ${selectedRows.filter((r) => r.state === 'importable').length} 笔`)}
          onDismiss={() => patchRows(selectedRows.map((r) => r.id), { state: 'dismissed', reason: 'user' }, `已忽略 ${selectedRows.length} 笔`)}
          onClear={() => setSelected(new Set())}
        />
      )}

      <Toasts items={toasts} onUndo={undo} />
      <Tweaks open={tweaksOpen} onToggle={() => setTweaksOpen((v) => !v)} state={tw} set={setT} />
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />)
