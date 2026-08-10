/* 展示层：来源面板（两版）、队列行（三版）、加载方式（三版）、批量条、toast、Tweaks。
   这里的组件都是 props 进、回调出，状态全在 app.jsx 的 App 里。 */

const { useState, useEffect, useRef } = React

/* ══ 工作量条 ══════════════════════════════════════════════
   原来的页头只说「待入账 114 笔」。114 笔要花多久、涉及多少钱、
   最老的一笔积压了多久，全看不出来 —— 于是人不知道该不该现在处理。 */
function Workload({ rows, done, total }) {
  /* 支出和收入分开算：混成一个净额，一笔工资就能把几十笔日常消费的量级抹平 */
  const out = rows.filter((r) => r.dir === '支出').reduce((s, r) => s + Number(r.amount), 0)
  const inc = rows.filter((r) => r.dir === '收入').reduce((s, r) => s + Number(r.amount), 0)
  const oldest = rows.reduce((min, r) => (!min || r.date < min ? r.date : min), null)
  const pct = total === 0 ? 0 : Math.round((done / total) * 100)
  return (
    <dl className="workload">
      <div className="stat">
        <dt>待处理</dt>
        <dd className="num">{rows.length}<small>笔</small></dd>
      </div>
      <div className="stat">
        <dt>支出</dt>
        <dd className="num">-¥{fmtAmount(out)}</dd>
      </div>
      <div className="stat">
        <dt>收入</dt>
        <dd className="num" style={{ color: inc > 0 ? 'var(--income)' : 'var(--text-tertiary)' }}>
          {inc > 0 ? `+¥${fmtAmount(inc)}` : '--'}
        </dd>
      </div>
      <div className="stat">
        <dt>最早一笔</dt>
        <dd className="num">{oldest ? dayLabel(oldest).slice(0, 5) : '--'}<small>{oldest ? relativeDay(oldest) : ''}</small></dd>
      </div>
      <div className="progress">
        <div className="label">
          <span>本次已处理 {done} / {total}</span>
          <span className="num">{pct}%</span>
        </div>
        <div className="bar"><i style={{ width: `${pct}%` }} /></div>
      </div>
    </dl>
  )
}

/* ══ 来源面板 · 版本一：可收起侧栏 ═════════════════════════
   渠道是「站台」，邮件是挂在站台下的车厢：渠道头给平台色底块，
   邮件行退到引导线右边、字号降一档 —— 这两层原来长得一样重。 */
function SourceSidebar({
  collapsed, onToggleCollapsed,
  channels, mails, counts,
  selectedChannel, selectedMail, onSelectChannel, onSelectMail, onUnlock,
}) {
  const [openChans, setOpenChans] = useState(() => new Set(channels.map((c) => c.key)))

  if (collapsed) {
    return (
      <aside className="card panel">
        <div className="rail">
          <button className="icon-btn" onClick={onToggleCollapsed} title="展开来源面板" aria-label="展开来源面板">
            <IconPanel />
          </button>
          <button
            aria-current={!selectedChannel && !selectedMail ? 'true' : undefined}
            onClick={() => onSelectChannel(null)}
            title="全部来源"
          >
            <PlatformMark kind="other" size={26} title="" />
          </button>
          {channels.map((c) => (
            <button
              key={c.key}
              aria-current={selectedChannel === c.key ? 'true' : undefined}
              onClick={() => onSelectChannel(selectedChannel === c.key ? null : c.key)}
              title={`${c.label} · ${counts[c.key] || 0} 笔`}
            >
              <PlatformMark kind={c.platform} size={26} title="" />
              {counts[c.key] > 0 && <span className="badge num">{counts[c.key]}</span>}
            </button>
          ))}
        </div>
      </aside>
    )
  }

  return (
    <aside className="card panel">
      <div className="panel-head">
        <h2>来源</h2>
        <span className="n num">{mails.length} 封邮件</span>
        <button className="icon-btn" onClick={onToggleCollapsed} title="收起来源面板" aria-label="收起来源面板">
          <IconPanel />
        </button>
      </div>
      <div className="panel-scroll">
        <button
          className="panel-all"
          aria-current={!selectedChannel && !selectedMail ? 'true' : undefined}
          onClick={() => onSelectChannel(null)}
        >
          全部来源
          <span className="n num">{Object.values(counts).reduce((a, b) => a + b, 0)}</span>
        </button>

        {channels.map((c) => {
          const list = mails.filter((m) => m.channel === c.key)
          const open = openChans.has(c.key)
          return (
            <section className="chan" key={c.key} style={pfVars(c.platform)}>
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <button
                  className="chan-head"
                  data-open={open}
                  aria-pressed={selectedChannel === c.key}
                  onClick={() => onSelectChannel(selectedChannel === c.key ? null : c.key)}
                  style={{ flex: 1 }}
                >
                  <PlatformMark kind={c.platform} size={20} title="" />
                  {c.label}
                  <span className="n num">{counts[c.key] || 0}</span>
                  <span
                    className="caret"
                    role="button"
                    tabIndex={0}
                    aria-label={open ? `收起${c.label}的邮件` : `展开${c.label}的邮件`}
                    onClick={(e) => {
                      e.stopPropagation()
                      setOpenChans((prev) => {
                        const next = new Set(prev)
                        if (next.has(c.key)) next.delete(c.key)
                        else next.add(c.key)
                        return next
                      })
                    }}
                  >
                    <IconCaret size={13} />
                  </span>
                </button>
              </div>

              {open && (
                <ul className="chan-mails">
                  {list.map((m) => (
                    <li key={m.id}>
                      <button
                        className="mail"
                        aria-current={selectedMail === m.id ? 'true' : undefined}
                        onClick={() => onSelectMail(selectedMail === m.id ? null : m.id)}
                      >
                        <span style={{ minWidth: 0 }}>
                          <span className="subject truncate" style={{ display: 'block' }}>{m.subject}</span>
                          <span className="meta">
                            <span className="num">{m.at}</span>
                            <span className="state" data-kind={MAIL_STATE[m.state].kind}>
                              <i className="pip" />
                              {MAIL_STATE[m.state].label}
                            </span>
                          </span>
                        </span>
                        <span className="mail-count num">{m.count > 0 ? `${m.count} 笔` : ''}</span>
                      </button>
                      {m.state === 'locked' && (
                        <div style={{ padding: '2px 0 6px 7px' }}>
                          <button className="btn" data-variant="secondary" data-size="xs" onClick={() => onUnlock(m)}>
                            <IconLock size={12} />
                            输入解压密码
                          </button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )
        })}
      </div>
    </aside>
  )
}

/* ══ 来源面板 · 版本二：顶部渠道条 ════════════════════════
   面板整个收进一排 chip，主区拿到全部宽度；选中渠道后第二行才展开它的邮件。 */
function ChannelBar({ channels, mails, counts, selectedChannel, selectedMail, onSelectChannel, onSelectMail }) {
  const list = selectedChannel ? mails.filter((m) => m.channel === selectedChannel) : []
  return (
    <div className="chanbar">
      <div className="chanbar-line">
        <button
          className="chip"
          data-plain="true"
          aria-pressed={!selectedChannel && !selectedMail}
          onClick={() => onSelectChannel(null)}
        >
          全部来源
          <span className="n num">{Object.values(counts).reduce((a, b) => a + b, 0)}</span>
        </button>
        {channels.map((c) => (
          <button
            key={c.key}
            className="chip"
            style={pfVars(c.platform)}
            aria-pressed={selectedChannel === c.key}
            onClick={() => onSelectChannel(selectedChannel === c.key ? null : c.key)}
          >
            <PlatformMark kind={c.platform} size={20} title="" />
            {c.label}
            <span className="n num">{counts[c.key] || 0}</span>
          </button>
        ))}
      </div>
      {selectedChannel && (
        <div className="mailchips">
          <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>邮件</span>
          {list.map((m) => (
            <button
              key={m.id}
              className="mailchip"
              aria-current={selectedMail === m.id ? 'true' : undefined}
              onClick={() => onSelectMail(selectedMail === m.id ? null : m.id)}
            >
              <span className="num">{m.at}</span>
              <span className="truncate" style={{ maxWidth: 190 }}>{m.subject}</span>
              <span className="state" data-kind={MAIL_STATE[m.state].kind} style={{ color: `var(--${MAIL_STATE[m.state].kind === 'warn' ? 'attention' : MAIL_STATE[m.state].kind === 'danger' ? 'danger' : MAIL_STATE[m.state].kind === 'ok' ? 'done' : 'text-tertiary'})` }}>
                {m.count > 0 ? `${m.count} 笔` : MAIL_STATE[m.state].label}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/* ══ 日期分组头 ═══════════════════════════════════════════ */
function DayHeader({ date, rows }) {
  const net = netOf(rows)
  return (
    <div className="daygroup">
      <span className="d num">{dayLabel(date)}</span>
      <span className="rel">{relativeDay(date)}</span>
      <span className="num">{rows.length} 笔</span>
      <span className="sum num">{net < 0 ? '-' : '+'}¥{fmtAmount(net)}</span>
    </div>
  )
}

/* ══ 分类 chip ════════════════════════════════════════════ */
function CatChip({ name, ai }) {
  if (!name) return <span className="cat" data-empty="true">未分类</span>
  return (
    <span className="cat" data-ai={ai ? 'true' : undefined} style={{ '--c': catTone(name) }}>
      {name}
      {ai && <span className="sr-only">（AI 建议）</span>}
    </span>
  )
}

/* ══ 队列行 ═══════════════════════════════════════════════
   三版共用同一份数据和动作，只换信息布局。 */
function QueueRow({
  row, shape, selected, cursor, expanded, view,
  onSelect, onCursor, onExpand, onAction,
}) {
  const amount = (
    <span className="amount num" data-dir={row.dir}>
      {sign(row.dir)}¥{fmtAmount(row.amount)}
    </span>
  )
  const check = (
    <input
      type="checkbox"
      checked={selected}
      aria-label={`选择 ${row.merchant}`}
      onChange={() => {}}
      onClick={(e) => { e.stopPropagation(); onSelect(e.shiftKey) }}
    />
  )
  const actions = (
    <span className="row-actions">
      {view === 'attention' && row.kind === 'transfer' && (
        <button className="btn" data-variant="secondary" data-size="xs" onClick={(e) => { e.stopPropagation(); onAction('confirm-transfer') }}>确认转账</button>
      )}
      {view === 'attention' && row.kind === 'duplicate' && (
        <button className="btn" data-variant="secondary" data-size="xs" onClick={(e) => { e.stopPropagation(); onAction('not-duplicate') }}>不是重复</button>
      )}
      {view === 'attention' && row.kind === 'split' && (
        <button className="btn" data-variant="secondary" data-size="xs" onClick={(e) => { e.stopPropagation(); onAction('split') }}>
          <IconSplit size={12} />拆分
        </button>
      )}
      {view === 'dismissed' ? (
        <button className="btn" data-variant="secondary" data-size="xs" onClick={(e) => { e.stopPropagation(); onAction('restore') }}>恢复</button>
      ) : view === 'imported' ? (
        <button className="btn" data-variant="ghost" data-size="xs" onClick={(e) => e.stopPropagation()}>查看交易</button>
      ) : (
        <>
          <button className="btn" data-variant="ghost" data-size="xs" onClick={(e) => { e.stopPropagation(); onExpand() }}>
            {row.kind === 'note' ? '补备注' : '编辑'}
          </button>
          <button className="btn" data-variant="danger" data-size="xs" onClick={(e) => { e.stopPropagation(); onAction('dismiss') }}>忽略</button>
          <button className="btn" data-variant="primary" data-size="xs" onClick={(e) => { e.stopPropagation(); onAction('import') }}>入账</button>
        </>
      )}
    </span>
  )

  const common = {
    className: 'row',
    'data-shape': shape,
    'data-selected': selected ? 'true' : undefined,
    'data-cursor': cursor ? 'true' : undefined,
    onMouseEnter: onCursor,
    onClick: onExpand,
  }

  if (shape === 'b') {
    return (
      <div {...common}>
        {check}
        <PlatformMark kind={row.platform} size={26} />
        <span className="stack">
          <span className="name truncate">{row.merchant}</span>
          {/* 次行只放「判断这笔要用到、但主行放不下」的三样：分类、平台、账户。
              来源邮件不放这儿 —— 同一封邮件解析出的几十笔会把它重复几十遍，
              那正是原来那版最吵的地方。要看来源，展开行里有。 */}
          <span className="line2">
            <CatChip name={row.category} ai={row.ai} />
            <span className="sep">·</span>
            <span style={{ color: 'var(--text-tertiary)' }}>{platformLabel(row.platform)}</span>
            <span className="sep">·</span>
            <span className="truncate">{accountLabel(row)}</span>
            {row.reason && <span className="flag" data-kind="warn">{row.reason}</span>}
          </span>
        </span>
        {amount}
        {actions}
      </div>
    )
  }

  if (shape === 'c') {
    return (
      <div {...common} className="row grid-c">
        {check}
        <span className="num" style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{row.date.slice(5)}</span>
        <PlatformMark kind={row.platform} size={22} />
        <span className="name truncate">{row.merchant}</span>
        <span className="truncate"><CatChip name={row.category} ai={row.ai} /></span>
        <span className="acct truncate">{accountLabel(row)}</span>
        {amount}
        {actions}
      </div>
    )
  }

  // shape a：单行紧凑，日期交给分组头
  return (
    <div {...common}>
      {check}
      <PlatformMark kind={row.platform} size={22} />
      <span className="merchant truncate">
        <span className="name">{row.merchant}</span>
      </span>
      {row.reason && <span className="flag" data-kind="warn">{row.reason}</span>}
      <CatChip name={row.category} ai={row.ai} />
      <span className="acct truncate" style={{ width: 176, flex: 'none', textAlign: 'right' }}>{accountLabel(row)}</span>
      {amount}
      {actions}
    </div>
  )
}

function TableHead() {
  return (
    <div className="thead grid-c">
      <span />
      <span>日期</span>
      <span>平台</span>
      <span>商户</span>
      <span>分类</span>
      <span>账户</span>
      <span>金额</span>
    </div>
  )
}

/* ══ 展开详情 ═════════════════════════════════════════════ */
function RowDetail({ row, onAction }) {
  const mail = mailOf(row.mail)
  return (
    <div className="detail">
      <dl>
        <div className="kv"><dt>原始描述</dt><dd>{platformLabel(row.platform)}-{row.merchant}</dd></div>
        <div className="kv"><dt>原始日期</dt><dd className="num">{row.date}</dd></div>
        <div className="kv"><dt>账户流向</dt><dd>{accountLabel(row)}</dd></div>
        <div className="kv"><dt>判重</dt><dd>{row.dupOf ? `与 ${row.dupOf} 疑似重复` : '没有重复'}</dd></div>
      </dl>
      {mail && (
        <div className="evidence">
          <PlatformMark kind={(CHANNELS.find((c) => c.key === mail.channel) || {}).platform} size={20} />
          <span className="subject">{mail.subject}</span>
          <span className="num" style={{ color: 'var(--text-tertiary)' }}>{mail.at} 收到</span>
          <button className="btn" data-variant="ghost" data-size="xs" style={{ marginLeft: 'auto' }}>看原始邮件</button>
        </div>
      )}
      {row.ai && (
        <p style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
          虚线框住的分类是 AI 给的建议，入账即视为确认；改一下就退回普通样式。
        </p>
      )}
      <div className="actions">
        <button className="btn" data-variant="secondary" data-size="xs">改分类</button>
        <button className="btn" data-variant="secondary" data-size="xs">改账户</button>
        <button className="btn" data-variant="secondary" data-size="xs"><IconSplit size={12} />拆分</button>
        <button className="btn" data-variant="danger" data-size="xs" onClick={() => onAction('dismiss')}>忽略这笔</button>
      </div>
    </div>
  )
}

/* ══ 加载方式 · 分页器 ════════════════════════════════════ */
function Pager({ page, pageSize, total, onPage, onPageSize }) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const nums = []
  for (let i = 1; i <= pages; i += 1) {
    if (i === 1 || i === pages || Math.abs(i - page) <= 1) nums.push(i)
    else if (nums[nums.length - 1] !== '…') nums.push('…')
  }
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(total, page * pageSize)
  return (
    <div className="pager">
      <span className="num">{from}–{to} / {total}</span>
      <div className="pages">
        <button className="pageno" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="上一页">
          <IconChevLeft size={14} />
        </button>
        {nums.map((n, i) =>
          n === '…' ? (
            <span key={`gap${i}`} className="pageno" style={{ cursor: 'default' }}>…</span>
          ) : (
            <button key={n} className="pageno num" aria-current={n === page ? 'page' : undefined} onClick={() => onPage(n)}>
              {n}
            </button>
          ),
        )}
        <button className="pageno" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="下一页">
          <IconCaret size={14} />
        </button>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        每页
        <select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}>
          <option value={20}>20</option>
          <option value={50}>50</option>
          <option value={100}>100</option>
        </select>
      </label>
    </div>
  )
}

/* ══ 加载方式 · 滚动加载 ══════════════════════════════════ */
function LoadMore({ shown, total, onMore }) {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!el || shown >= total) return
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) onMore()
    }, { rootMargin: '120px' })
    io.observe(el)
    return () => io.disconnect()
  }, [shown, total, onMore])

  if (shown >= total) {
    return <div className="loadmore">到底了 · 共 {total} 笔</div>
  }
  return (
    <div className="loadmore" ref={ref}>
      <span className="spin"><IconSync size={14} /></span>
      正在加载 · 已显示 {shown} / {total}
    </div>
  )
}

/* ══ 加载方式 · 按邮件批次折叠 ════════════════════════════ */
function BatchSection({ mail, rows, open, onToggle, onImportBatch, onSelectBatch, children }) {
  const channel = CHANNELS.find((c) => c.key === mail.channel) || CHANNELS[0]
  return (
    <section className="batch" style={pfVars(channel.platform)}>
      <button className="batch-head" data-open={open} onClick={onToggle}>
        <span className="caret"><IconCaret size={13} /></span>
        <PlatformMark kind={channel.platform} size={22} />
        <span style={{ minWidth: 0 }}>
          <span className="subject truncate" style={{ display: 'block' }}>{mail.subject}</span>
          <span className="meta num">{mail.at} 收到 · 解析出 {rows.length} 笔 · 合计 -¥{fmtAmount(netOf(rows))}</span>
        </span>
        <span className="right">
          <span
            className="btn" data-variant="secondary" data-size="xs" role="button" tabIndex={0}
            onClick={(e) => { e.stopPropagation(); onSelectBatch() }}
          >
            全选这批
          </span>
          <span
            className="btn" data-variant="primary" data-size="xs" role="button" tabIndex={0}
            onClick={(e) => { e.stopPropagation(); onImportBatch() }}
          >
            入账这批 {rows.length} 笔
          </span>
        </span>
      </button>
      {open && children}
    </section>
  )
}

/* ══ 批量操作条 ═══════════════════════════════════════════ */
function BulkBar({ rows, onImport, onDismiss, onClear }) {
  return (
    <div className="bulkbar">
      <span className="count">已选 <b className="num">{rows.length}</b> 笔</span>
      <span className="sum num">-¥{fmtAmount(netOf(rows))}</span>
      <button className="btn" data-variant="primary" onClick={onImport}>
        <IconCheck size={14} />入账 {rows.length} 笔
      </button>
      <button className="btn" data-variant="danger" onClick={onDismiss}>忽略</button>
      <button className="btn" data-variant="ghost" onClick={onClear}>取消</button>
    </div>
  )
}

/* ══ toast ════════════════════════════════════════════════ */
function Toasts({ items, onUndo }) {
  return (
    <div className="toasts">
      {items.map((t) => (
        <div className="toast" key={t.id} data-kind={t.kind}>
          <i className="pip" />
          <span>{t.message}</span>
          {t.undo && <button onClick={() => onUndo(t)}>撤销</button>}
        </div>
      ))}
    </div>
  )
}

/* ══ 空态 ═════════════════════════════════════════════════ */
function Empty({ message, actionLabel, onAction }) {
  return (
    <div className="empty">
      <IconInbox size={26} />
      <span className="msg">{message}</span>
      {actionLabel && <button className="btn" data-variant="secondary" onClick={onAction}>{actionLabel}</button>}
    </div>
  )
}

/* ══ Tweaks：变体开关 ═════════════════════════════════════ */
function Seg({ label, value, options, onChange }) {
  return (
    <div className="group">
      <h3>{label}</h3>
      <div className="seg">
        {options.map((o) => (
          <button key={o.value} aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function Tweaks({ open, onToggle, state, set }) {
  return (
    <>
      <button className="tweaks-toggle" onClick={onToggle}>
        <IconSlider size={14} />
        {open ? '收起 Tweaks' : 'Tweaks'}
      </button>
      {open && (
        <div className="tweaks">
          <Seg
            label="行结构"
            value={state.shape}
            onChange={(v) => set({ shape: v })}
            options={[
              { value: 'a', label: 'A 单行' },
              { value: 'b', label: 'B 双行' },
              { value: 'c', label: 'C 表格' },
            ]}
          />
          <Seg
            label="加载方式"
            value={state.paging}
            onChange={(v) => set({ paging: v })}
            options={[
              { value: 'pager', label: '分页' },
              { value: 'scroll', label: '滚动' },
              { value: 'batch', label: '批次' },
            ]}
          />
          <Seg
            label="来源面板"
            value={state.panel}
            onChange={(v) => set({ panel: v })}
            options={[
              { value: 'side', label: '侧栏' },
              { value: 'bar', label: '顶部条' },
            ]}
          />
          <Seg
            label="密度"
            value={state.density}
            onChange={(v) => set({ density: v })}
            options={[
              { value: 'compact', label: '紧凑' },
              { value: 'comfortable', label: '宽松' },
            ]}
          />
          <Seg
            label="主题"
            value={state.theme}
            onChange={(v) => set({ theme: v })}
            options={[
              { value: 'light', label: '浅色' },
              { value: 'dark', label: '深色' },
            ]}
          />
          <div className="group">
            <h3>平台标记</h3>
            <div className="marks">
              {Object.keys(PLATFORMS).map((key) => (
                <span className="markcell" key={key}>
                  <PlatformMark kind={key} size={22} title="" />
                  <span>{PLATFORMS[key].label}</span>
                </span>
              ))}
            </div>
          </div>

          <p className="hint">
            键盘：j／k 上下 · x 勾选 · e 展开 · d 忽略 · Enter 入账所选。<br />
            行结构 C 用日期列取代日期分组头。
          </p>
        </div>
      )}
    </>
  )
}

Object.assign(window, {
  Workload, SourceSidebar, ChannelBar, DayHeader, CatChip, QueueRow, TableHead,
  RowDetail, Pager, LoadMore, BatchSection, BulkBar, Toasts, Empty, Tweaks, Seg,
})
