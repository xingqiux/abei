/* v2 展示层。props 进、回调出，状态都在 app-v2 的 App 里。
   与 v1 的区别全在结构件：四个平级 tab 换成「管道叙事 + 两层开关」，
   渠道条换成语义单一的「账单来源」行，邮件从一条弱化 chip 横条
   升格为可展开的「邮件清单」。行、批量条、toast 沿用 v1 的骨架。 */

const { useState, useEffect, useRef } = React

/* ══ 管道叙事 ═════════════════════════════════════════════
   一条线讲清楚：邮箱 → 邮件 → 解析 → 系统自动处理 → 你处理。
   每个数字都能点过去看明细；侧边栏徽标那种「136+36+9 封邮件」
   的混单位加法在这一版不存在了。 */

function StageArrow() {
  return (
    <span className="pipe-arrow" aria-hidden="true"><IconCaret size={12} /></span>
  )
}

function PipeStrip({ variant, stats, ledgerOpen, layer, doneFilter, onOpenLedger, onGoDone, onGoTodo }) {
  const stages = [
    {
      key: 'mails', v: stats.mails, unit: '封', k: '账单邮件',
      active: ledgerOpen, onClick: onOpenLedger,
    },
    { key: 'parsed', v: stats.parsed, unit: '笔', k: '解析出的流水' },
    {
      key: 'auto', v: stats.auto, unit: '笔', k: '系统处理',
      active: layer === 'done' && doneFilter === 'system', onClick: () => onGoDone('system'),
    },
    {
      key: 'byyou', v: stats.byYou, unit: '笔', k: '手动处理', tone: 'done',
      active: layer === 'done' && doneFilter === 'byyou', onClick: () => onGoDone('byyou'),
    },
    {
      key: 'todo', v: stats.todo, unit: '笔', k: '待处理',
      tone: 'brand', active: layer === 'todo', onClick: onGoTodo,
    },
  ]

  if (variant === 'steps') {
    return (
      <div className="pipe-steps">
        {stages.map((s, i) => (
          <button key={s.key} className="pstep" data-tone={s.tone} data-active={s.active ? 'true' : undefined}
            onClick={s.onClick} disabled={!s.onClick}>
            <span className="v num">{s.v}<small>{s.unit}</small></span>
            <span className="k">{s.k}</span>
            {i < stages.length - 1 && <span className="arrow"><IconCaret size={12} /></span>}
          </button>
        ))}
      </div>
    )
  }

  return (
    <div className="pipe-line">
      {stages.map((s, i) => (
        <React.Fragment key={s.key}>
          <button className="stage" data-tone={s.tone} data-active={s.active ? 'true' : undefined}
            onClick={s.onClick} disabled={!s.onClick}>
            <span className="v num">{s.v}<small>{s.unit}</small></span>
            <span className="k">{s.k}</span>
          </button>
          {i < stages.length - 1 && <StageArrow />}
        </React.Fragment>
      ))}
    </div>
  )
}

/* 卡住的邮件不再折进某个数字里，摆到明面上 */
function PipeWarn({ locked, failed, onOpenLedger }) {
  if (locked === 0 && failed === 0) return null
  const parts = []
  if (locked > 0) parts.push(`${locked} 封待解锁`)
  if (failed > 0) parts.push(`${failed} 封解析失败`)
  return (
    <div className="pipe-warn">
      <IconLock size={13} />
      <span><b>{parts.join(' · ')}</b>，其中的流水尚未解析</span>
      <button className="btn" data-variant="secondary" data-size="xs" onClick={onOpenLedger}>查看邮件</button>
    </div>
  )
}

/* ══ 邮件清单 ═════════════════════════════════════════════
   「账单收件箱」终于有收件箱的样子：一封封邮件、各自状态、
   解析进度、卡住的原地解决。点一封 = 只看它解析出的流水。 */

function MailLedger({ mails, mailStats, selectedMail, onSelectMail, onClose, unlock, setUnlock, onUnlockPreview, onUnlockConfirm, onRetry, toast }) {
  return (
    <section className="card ledger" data-screen-label="邮件清单">
      <div className="ledger-head">
        <h2>邮件清单</h2>
        <span className="sub num">共 {MAIL_TOTAL} 封 · 来自绑定的邮箱</span>
        <button className="icon-btn" aria-label="收起邮件清单" onClick={onClose}><IconX size={14} /></button>
      </div>
      <div className="ledger-cols">
        {CHANNELS.map((c) => {
          const list = mails.filter((m) => m.channel === c.key)
          const older = c.mailTotal - list.length
          return (
            <div className="ledger-chan" key={c.key} style={pfVars(c.platform)}>
              <div className="chead">
                <PlatformMark kind={c.platform} size={20} title="" />
                {c.label}
                <span className="n num">{c.mailTotal} 封</span>
              </div>
              {list.map((m) => {
                const st = mailStats[m.id] || { total: 0, todo: 0 }
                const meta = MAIL_STATE[m.state]
                return (
                  <React.Fragment key={m.id}>
                    <button className="lmail" aria-current={selectedMail === m.id ? 'true' : undefined}
                      onClick={() => onSelectMail(selectedMail === m.id ? null : m.id)}>
                      <span className="top">
                        <span className="num">{m.at}</span>
                        <span className="subject truncate">{m.subject}</span>
                      </span>
                      <span className="sub">
                        <span className="state" data-kind={meta.kind}><i className="pip" />{meta.label}</span>
                        {st.total > 0 && (
                          <span className="num">
                            解析 {st.total} 笔{st.todo > 0 ? ` · 待处理 ${st.todo} 笔` : ' · 已处理'}
                          </span>
                        )}
                      </span>
                    </button>
                    {m.state === 'locked' && (
                      <div className="unlockbox">
                        <div className="line">
                          <input
                            type="password"
                            placeholder="解压密码"
                            value={(unlock[m.id] || {}).pwd || ''}
                            onChange={(e) => setUnlock(m.id, { pwd: e.target.value, previewed: false })}
                          />
                          {(unlock[m.id] || {}).previewed ? (
                            <button className="btn" data-variant="primary" data-size="xs" onClick={() => onUnlockConfirm(m)}>开始解析</button>
                          ) : (
                            <button className="btn" data-variant="secondary" data-size="xs"
                              disabled={!((unlock[m.id] || {}).pwd)} onClick={() => onUnlockPreview(m)}>
                              <IconLock size={12} />解锁
                            </button>
                          )}
                        </div>
                        <span className="note">
                          {(unlock[m.id] || {}).previewed
                            ? '校验通过，预览到 41 笔流水'
                            : '密码仅在本机用于解压，不会上传'}
                        </span>
                      </div>
                    )}
                    {m.state === 'failed' && (
                      <div style={{ padding: '0 7px 6px' }}>
                        <button className="btn" data-variant="secondary" data-size="xs" onClick={() => onRetry(m)}>
                          <IconSync size={12} />重新解析
                        </button>
                      </div>
                    )}
                  </React.Fragment>
                )
              })}
              {older > 0 && (
                <button className="lmail-more" onClick={() => toast('更早的邮件均已处理，原型仅列出近期邮件')}>
                  更早 {older} 封 · 已处理 ▸
                </button>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

/* ══ 两层开关 + 账单来源 ══════════════════════════════════ */

function LayerSwitch({ layer, todo, attention, done, onLayer }) {
  return (
    <div className="layerseg" role="tablist" aria-label="处理状态">
      <button role="tab" aria-selected={layer === 'todo'} onClick={() => onLayer('todo')}>
        待处理 <span className="n num">{todo}</span>
        {attention > 0 && <i className="dot" />}
      </button>
      <button role="tab" aria-selected={layer === 'done'} onClick={() => onLayer('done')}>
        已完成 <span className="n num">{done}</span>
      </button>
    </div>
  )
}

/* chip 的数字语义唯一：该来源还剩多少笔待处理。
   不跟着当前层变，也不受别的来源选中影响 —— 这是 v1 两张截图
   互相矛盾的根源，v2 里写死成一个口径。 */
function SourceLine({ todoBySource, todoTotal, selected, onSelect }) {
  return (
    <div className="srcline">
      <span className="lbl">账单来源</span>
      <button className="chip" data-plain="true" aria-pressed={!selected} onClick={() => onSelect(null)}>
        全部 <span className="n num">{todoTotal}</span>
      </button>
      {CHANNELS.map((c) => {
        const n = todoBySource[c.key] || 0
        return (
          <button key={c.key} className="chip" style={pfVars(c.platform)}
            aria-pressed={selected === c.key}
            onClick={() => onSelect(selected === c.key ? null : c.key)}
            title={`${c.label}来源的账单邮件，剩 ${n} 笔待处理`}>
            <PlatformMark kind={c.platform} size={20} title="" />
            {c.label}
            <span className="n num" data-zero={n === 0 ? 'true' : undefined}>{n}</span>
          </button>
        )
      })}
    </div>
  )
}

/* ══ 日期分组头 / 分类 chip（沿用 v1）═════════════════════ */

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

function CatChip({ name, ai }) {
  if (!name) return <span className="cat" data-empty="true">未分类</span>
  return (
    <span className="cat" data-ai={ai ? 'true' : undefined} style={{ '--c': catTone(name) }}>
      {name}
      {ai && <span className="sr-only">（AI 建议）</span>}
    </span>
  )
}

/* ══ 行 ═══════════════════════════════════════════════════
   单行紧凑版（v1 定稿的 A 结构），叠上 v2 的三件事：
   ① 支付方式 tag（原来这个字段前端根本没显示）
   ② 行内溯源徽章（Tweaks 可开）
   ③ 动作跟着「这行需要你做的判断」走，不再按 tab 一刀切 */

const KIND_FLAG = {
  transfer: '疑似转账',
  duplicate: '重复 · 已合并',
  split: '需拆分',
  note: '需补备注',
}

function QRow({ row, selected, cursor, expanded, prov, onSelect, onCursor, onExpand, onAction }) {
  const mail = mailOf(row.mail)
  const amount = (
    <span className="amount num" data-dir={row.dir}>
      {sign(row.dir)}¥{fmtAmount(row.amount)}
    </span>
  )
  const dismissMeta = row.state === 'dismissed' ? DISMISS_META[row.reason] : null

  const actions = (
    <span className="row-actions">
      {row.state === 'attention' && row.kind === 'transfer' && (
        <>
          <button className="btn" data-variant="secondary" data-size="xs" onClick={(e) => { e.stopPropagation(); onAction('confirm-transfer') }}>是转账</button>
          <button className="btn" data-variant="ghost" data-size="xs" onClick={(e) => { e.stopPropagation(); onAction('not-transfer') }}>不是</button>
        </>
      )}
      {row.state === 'attention' && row.kind === 'duplicate' && (
        <>
          <button className="btn" data-variant="secondary" data-size="xs" onClick={(e) => { e.stopPropagation(); onAction('confirm-duplicate') }}>确认合并</button>
          <button className="btn" data-variant="ghost" data-size="xs" onClick={(e) => { e.stopPropagation(); onAction('not-duplicate') }}>不是重复</button>
        </>
      )}
      {row.state === 'attention' && row.kind === 'split' && (
        <button className="btn" data-variant="secondary" data-size="xs" onClick={(e) => { e.stopPropagation(); onAction('split') }}>
          <IconSplit size={12} />拆分
        </button>
      )}
      {row.state === 'attention' && row.kind === 'note' && (
        <button className="btn" data-variant="secondary" data-size="xs" onClick={(e) => { e.stopPropagation(); onExpand() }}>补备注</button>
      )}
      {row.state === 'importable' && (
        <>
          <button className="btn" data-variant="ghost" data-size="xs" onClick={(e) => { e.stopPropagation(); onExpand() }}>编辑</button>
          <button className="btn" data-variant="danger" data-size="xs" onClick={(e) => { e.stopPropagation(); onAction('dismiss') }}>忽略</button>
          <button className="btn" data-variant="primary" data-size="xs" onClick={(e) => { e.stopPropagation(); onAction('import') }}>入账</button>
        </>
      )}
      {row.state === 'dismissed' && (
        <button className="btn" data-variant="secondary" data-size="xs" onClick={(e) => { e.stopPropagation(); onAction('restore') }}>恢复</button>
      )}
      {row.state === 'imported' && (
        <button className="btn" data-variant="ghost" data-size="xs" onClick={(e) => e.stopPropagation()}>查看交易</button>
      )}
    </span>
  )

  return (
    <div
      className="row"
      data-selected={selected ? 'true' : undefined}
      data-cursor={cursor ? 'true' : undefined}
      onMouseEnter={onCursor}
      onClick={onExpand}
    >
      <input
        type="checkbox"
        checked={selected}
        aria-label={`选择 ${row.merchant}`}
        onChange={() => {}}
        onClick={(e) => { e.stopPropagation(); onSelect(e.shiftKey) }}
      />
      <PlatformMark kind={row.platform} size={22} />
      <span className="merchant truncate"><span className="name">{row.merchant}</span></span>
      {row.state === 'attention' && <span className="flag" data-kind="warn">{KIND_FLAG[row.kind]}</span>}
      {dismissMeta && <span className="flag" data-kind={row.reason === 'user' ? 'muted' : 'brand'}>{dismissMeta.flag}</span>}
      {row.state === 'imported' && <span className="flag" data-kind="ok">已入账</span>}
      {row.pay && row.state === 'attention' && <span className="paytag">{row.pay}</span>}
      <CatChip name={row.category} ai={row.ai} />
      {prov && mail && (
        <span className="prov num" title={`来自「${mail.subject}」（${mail.at} 收到）`}>
          {mail.at} 邮件
        </span>
      )}
      <span className="acct truncate" style={{ width: 176, flex: 'none', textAlign: 'right' }}>{accountLabel(row)}</span>
      {amount}
      {actions}
    </div>
  )
}

/* ══ 展开详情：溯源在这里说全 ═════════════════════════════ */

function QDetail({ row, onAction }) {
  const mail = mailOf(row.mail)
  const chan = mail ? channelOf(mail.channel) : null
  return (
    <div className="detail">
      <dl>
        <div className="kv"><dt>原始描述</dt><dd>{row.merchant}</dd></div>
        <div className="kv"><dt>原始日期</dt><dd className="num">{row.date}</dd></div>
        <div className="kv"><dt>支付方式</dt><dd>{row.pay || '——'}</dd></div>
        <div className="kv"><dt>账户流向</dt><dd>{accountLabel(row)}</dd></div>
      </dl>
      {row.dupMails && (
        <div className="mergecard">
          <span className="l">
            <IconAlert size={13} />
            这笔在 {row.dupMails.length} 封邮件里都出现，系统已合并为一条，最多只会入账一次。
          </span>
          <span className="l num" style={{ color: 'var(--text-secondary)' }}>
            {row.dupMails.map((id) => {
              const m = mailOf(id)
              return m ? `${m.at}「${m.subject}」` : id
            }).join(' 与 ')}
          </span>
        </div>
      )}
      {mail && (
        <div className="evidence">
          {chan && <PlatformMark kind={chan.platform} size={20} />}
          <span className="subject">{mail.subject}</span>
          <span className="num" style={{ color: 'var(--text-tertiary)' }}>{mail.at} 收到</span>
          <button className="btn" data-variant="ghost" data-size="xs" style={{ marginLeft: 'auto' }}>看原始邮件</button>
        </div>
      )}
      <div className="actions">
        <button className="btn" data-variant="secondary" data-size="xs">改分类</button>
        <button className="btn" data-variant="secondary" data-size="xs">改账户</button>
        <button className="btn" data-variant="secondary" data-size="xs"><IconSplit size={12} />拆分</button>
        {row.state !== 'dismissed' && row.state !== 'imported' && (
          <button className="btn" data-variant="danger" data-size="xs" onClick={() => onAction('dismiss')}>忽略这笔</button>
        )}
      </div>
    </div>
  )
}

/* ══ 需你判断（待处理层的前置块）══════════════════════════ */

const JUDGE_SECTIONS = [
  { kind: 'transfer', label: '疑似转账', hint: '确认后记成账户之间的转账，不计入收支。' },
  { kind: 'duplicate', label: '疑似重复', hint: '同一渠道两封邮件里的同一笔，已自动合并，等你拍板。' },
  { kind: 'split', label: '需拆分', hint: '一笔付款含多件商品，拆开才好归类。' },
  { kind: 'note', label: '需补备注', hint: '看不出这笔钱去哪了，补一句以后才查得回来。' },
]

function AttentionBlock({ rows, open, onToggle, renderRow }) {
  if (rows.length === 0) return null
  const byKind = JUDGE_SECTIONS
    .map((s) => ({ ...s, list: rows.filter((r) => r.kind === s.kind) }))
    .filter((s) => s.list.length > 0)
  return (
    <div className="attn">
      <button className="attn-head" data-open={open} onClick={onToggle}>
        <IconAlert size={14} />
        <b>{rows.length} 笔需要你判断</b>
        <span className="kinds">
          {byKind.map((s, i) => (
            <React.Fragment key={s.kind}>
              {i > 0 && <span className="sep">·</span>}
              <span>{s.label} <span className="num">{s.list.length}</span></span>
            </React.Fragment>
          ))}
        </span>
        <span className="caret"><IconCaret size={13} /></span>
      </button>
      {open && (
        <div className="attn-body">
          {byKind.map((s) => (
            <section key={s.kind}>
              <div className="judgehead">
                <span className="d">{s.label}</span>
                <span className="num">{s.list.length} 笔</span>
                <span>{s.hint}</span>
              </div>
              {s.list.map(renderRow)}
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

/* ══ 已完成层的筛选 chips ═════════════════════════════════
   已入账和各种忽略不是并排的工作区，是「怎么处理掉的」记录。
   系统做的和你做的分开列。 */

function DoneFilters({ counts, filter, onFilter }) {
  const items = [
    { key: 'all', label: '全部', n: counts.all },
    { key: 'imported', label: '已入账', n: counts.imported },
    { key: 'user', label: '你忽略的', n: counts.user },
    { key: 'dup_auto', label: '合并的重复', n: counts.dup_auto },
    { key: 'zero', label: '清理的零元行', n: counts.zero },
    { key: 'archived', label: '随邮件归档', n: counts.archived },
  ]
  return (
    <div className="doneline">
      <span className="lbl">处理方式</span>
      {items.map((it) => (
        <button key={it.key} className="chip" data-plain="true"
          aria-pressed={filter === it.key} onClick={() => onFilter(it.key)}>
          {it.label} <span className="n num">{it.n}</span>
        </button>
      ))}
    </div>
  )
}

/* ══ 批量条 / toast / 空态 / 滚动加载（沿用 v1 骨架）═══════ */

function BulkBar({ rows, onImport, onDismiss, onClear }) {
  const importable = rows.filter((r) => r.state === 'importable')
  return (
    <div className="bulkbar">
      <span className="count">已选 <b className="num">{rows.length}</b> 笔</span>
      <span className="sum num">-¥{fmtAmount(Math.abs(netOf(rows)))}</span>
      <button className="btn" data-variant="primary" disabled={importable.length === 0} onClick={onImport}>
        <IconCheck size={14} />入账 {importable.length} 笔
      </button>
      <button className="btn" data-variant="danger" onClick={onDismiss}>忽略</button>
      <button className="btn" data-variant="ghost" onClick={onClear}>取消</button>
    </div>
  )
}

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

function Empty({ message, why, actions }) {
  return (
    <div className="empty">
      <IconInbox size={26} />
      <span className="msg">{message}</span>
      {why && <span className="why">{why}</span>}
      {actions && actions.length > 0 && (
        <span className="row-btns">
          {actions.map((a) => (
            <button key={a.label} className="btn" data-variant={a.primary ? 'primary' : 'secondary'} onClick={a.onClick}>
              {a.label}
            </button>
          ))}
        </span>
      )}
    </div>
  )
}

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

/* ══ Tweaks：v2 的变体开关 ════════════════════════════════ */

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
            label="管道叙事"
            value={state.pipe}
            onChange={(v) => set({ pipe: v })}
            options={[
              { value: 'line', label: '一行叙事' },
              { value: 'steps', label: '分步卡' },
            ]}
          />
          <Seg
            label="需你判断"
            value={state.attn}
            onChange={(v) => set({ attn: v })}
            options={[
              { value: 'collapsed', label: '收起条' },
              { value: 'open', label: '默认展开' },
            ]}
          />
          <Seg
            label="行内溯源"
            value={state.prov}
            onChange={(v) => set({ prov: v })}
            options={[
              { value: 'detail', label: '展开可见' },
              { value: 'inline', label: '行内徽章' },
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
          <p className="hint">
            键盘：j／k 上下 · x 勾选 · e 展开 · d 忽略 · Enter 入账所选。<br />
            数字都从同一份数据推导，任何视图下都能加得平。
          </p>
        </div>
      )}
    </>
  )
}

Object.assign(window, {
  PipeStrip, PipeWarn, MailLedger, LayerSwitch, SourceLine,
  DayHeader, CatChip, QRow, QDetail, AttentionBlock, DoneFilters,
  BulkBar, Toasts, Empty, LoadMore, Seg, Tweaks, JUDGE_SECTIONS, KIND_FLAG,
})
