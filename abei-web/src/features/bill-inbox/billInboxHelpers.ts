import type {
  BillMailboxSyncResult,
  BillQueueRow,
  BillRowPair,
  BillTask,
  BillTaskStatus,
} from '../../api/schemas'
import type { ChipKind } from '../../components/abei/StatusChip'
import { isPositiveDecimal } from '../../lib/decimal'
import { BRAND_MARKS, type BrandKey, type PlatformKey } from './brandMarks'
import { pairSectionHint } from './copy'

/** 邮件状态中文标签 + chip 语义色（术语表：待解锁 / 解析失败 / 已忽略 / 已入账） */
export const TASK_STATUS_META: Record<BillTaskStatus, { label: string; kind: ChipKind }> = {
  received: { label: '已接收', kind: 'muted' },
  ready: { label: '待解析', kind: 'warn' },
  needs_secret: { label: '待解锁', kind: 'warn' },
  parsed: { label: '已解析', kind: 'ok' },
  imported: { label: '已入账', kind: 'muted' },
  failed: { label: '解析失败', kind: 'danger' },
  unknown: { label: '解析失败', kind: 'danger' },
  ignored: { label: '已忽略', kind: 'muted' },
  cleaned: { label: '已忽略', kind: 'muted' },
}

/**
 * 收件箱的四个状态 tab（设计稿 06 §一）。写在路由 search 的 `view` 上，
 * 可直链；undefined 等同 `importable`（待入账，默认那个）。
 */
export type InboxView = 'importable' | 'attention' | 'dismissed' | 'imported'

export const INBOX_VIEWS: InboxView[] = ['importable', 'attention', 'dismissed', 'imported']

export function isInboxView(value: unknown): value is InboxView {
  return typeof value === 'string' && (INBOX_VIEWS as string[]).includes(value)
}

export const INBOX_VIEW_LABELS: Record<InboxView, string> = {
  importable: '待入账',
  attention: '待确认',
  dismissed: '已忽略',
  imported: '已入账',
}

/** 默认落在「待入账」；search 里没写 view 时用它，别在页面里各写各的 */
export const DEFAULT_INBOX_VIEW: InboxView = 'importable'

/* ------------------------------------------------------------------ *
 * 两层信息架构：一级只有「待处理 / 已完成」
 *
 * 老的四个 tab（待入账 / 待确认 / 已忽略 / 已入账）是四个并列入口，等于把
 * 「这批账清完没有」这件事拆成四个数字让人自己合并。改成两层之后，
 * 一级回答「还有没有活」，二级（分节）才回答「是哪一类活」。
 *
 * 四个老 view 全部保留为**输入**：旧链接、旧书签、别处写死的 ?view=attention
 * 都还认，只是被 normalizeInboxSearch 折算成新的两层坐标。
 * ------------------------------------------------------------------ */

/** 一级 tab */
export type InboxTab = 'pending' | 'done'

export const INBOX_TABS: InboxTab[] = ['pending', 'done']

export const INBOX_TAB_LABELS: Record<InboxTab, string> = {
  pending: '待处理',
  done: '已完成',
}

/** 「已完成」层里的二级切换。它俩共用一层，因为两边都是「不用再管了」。 */
export type DoneView = Extract<InboxView, 'imported' | 'dismissed'>

export const DONE_VIEWS: DoneView[] = ['imported', 'dismissed']

export const DONE_VIEW_LABELS: Record<DoneView, string> = {
  imported: '已入账',
  dismissed: '已忽略',
}

export function isInboxTab(value: unknown): value is InboxTab {
  return value === 'pending' || value === 'done'
}

export function isDoneView(value: unknown): value is DoneView {
  return value === 'imported' || value === 'dismissed'
}

/**
 * 「待处理」层里的定位锚。
 *
 * 不是筛选——待处理层永远同时渲染「待入账」和「待确认」两块，
 * 锚只决定进来时滚到哪一块。旧链接 ?view=attention 的语义（我要看待确认的那堆）
 * 就落在这上面，落成筛选反而会把另一半藏起来，和两层叙事自相矛盾。
 */
export type PendingSection = 'importable' | 'attention'

export function isPendingSection(value: unknown): value is PendingSection {
  return value === 'importable' || value === 'attention'
}

/** 分节在 DOM 上的 id，路由锚点和 aria-controls 共用一个来源 */
export const PENDING_SECTION_IDS: Record<PendingSection, string> = {
  importable: 'bill-inbox-importable',
  attention: 'bill-inbox-attention',
}

/**
 * 路由 search 的形状。**每一项都是可选的**，缺省即默认值（待处理 / 已入账）：
 * 默认值不写进 URL，`/bill-inbox` 这个裸地址才留得住，站内那几处
 * `<Link to="/bill-inbox">` 也不必被迫写一份 search 出来。
 */
export interface InboxSearch {
  source?: string
  task?: string
  /** undefined = 待处理 */
  tab?: InboxTab
  /** 只在 tab === 'done' 时有意义；undefined = 已入账 */
  done?: DoneView
  /** 只在待处理层有意义；undefined = 不滚动，停在顶上 */
  section?: PendingSection
}

export const DEFAULT_INBOX_TAB: InboxTab = 'pending'
export const DEFAULT_DONE_VIEW: DoneView = 'imported'

/**
 * 把 URL 上的 search 折算成两层坐标，顺带认下四个老 view 值。
 *
 * 新参数优先：同时写了 tab 和 view 时以 tab 为准（说明是新版页面自己写的），
 * view 只在新参数缺席时兜底。这样「新页面改了 tab → 老 view 还留在 URL 上」
 * 不会把人弹回旧位置。
 */
export function normalizeInboxSearch(raw: Record<string, unknown>): InboxSearch {
  const base: InboxSearch = {
    source: typeof raw.source === 'string' && raw.source !== '' ? raw.source : undefined,
    task: typeof raw.task === 'string' && raw.task !== '' ? raw.task : undefined,
  }

  if (isInboxTab(raw.tab)) {
    if (raw.tab === 'done') {
      return { ...base, tab: 'done', done: isDoneView(raw.done) ? raw.done : undefined }
    }
    return { ...base, section: isPendingSection(raw.section) ? raw.section : undefined }
  }

  // 老链接：四个 view 各自折到新坐标上
  if (isInboxView(raw.view)) {
    if (raw.view === 'imported') return { ...base, tab: 'done' }
    if (raw.view === 'dismissed') return { ...base, tab: 'done', done: 'dismissed' }
    // importable / attention 都在待处理层，只是滚到不同的分节
    return { ...base, section: raw.view }
  }

  return base
}

/** search → 一级 tab。缺省是待处理。 */
export function inboxTabOf(search: InboxSearch): InboxTab {
  return search.tab ?? DEFAULT_INBOX_TAB
}

/** search → 已完成层看哪一半。缺省是已入账。 */
export function doneViewOf(search: InboxSearch): DoneView {
  return search.done ?? DEFAULT_DONE_VIEW
}

/**
 * 进来先落在「有活的地方」。
 *
 * 固定落待入账的问题是：账户没对上时待入账恒为 0，用户开局看到的是一个空列表，
 * 而 15 笔活儿全堆在旁边那个 tab 上。待入账有货就待入账，否则看待确认，
 * 两个都空再退回待入账（空态那句话会告诉他下一步）。
 */
export function activeInboxView(counts: { importable: number; attention: number }): InboxView {
  if (counts.importable > 0) return 'importable'
  if (counts.attention > 0) return 'attention'
  return 'importable'
}

/** 需要人动手的邮件：等密码，或者解析出错 */
export const STUCK_TASK_STATUSES: BillTaskStatus[] = ['needs_secret', 'failed', 'unknown']

/** 已经从收件箱移走的邮件，不进来源面板 */
export const CLOSED_TASK_STATUSES: BillTaskStatus[] = ['ignored', 'cleaned']

/** 渠道 key 兜底中文名，正常情况下应优先用 /bill-inbox/summary 返回的 channel.name */
export const SOURCE_FALLBACK_LABELS: Record<string, string> = {
  alipay: '支付宝',
  wechat: '微信支付',
  cmb: '招商银行',
  boc: '中国银行',
}

/**
 * 渠道名只写渠道本身（术语表）：后端的 channel.name 是「支付宝交易流水」这种
 * 带用途后缀的全称，摆在 chip 和分组头上又长又重复。
 *
 * 服务端还没配中文名时会把 name 原样写成 key（`name = "cmb"`），
 * 那时候必须退回内置中文名——否则 chip 上写着 cmb，同屏卡片却写着招商银行。
 */
export function channelDisplayName(key: string, name?: string | null): string {
  const fallback = SOURCE_FALLBACK_LABELS[key] || key
  const trimmed = (name ?? '').trim()
  if (trimmed === '' || trimmed === key) return fallback
  const stripped = trimmed.replace(/(交易流水明细|交易流水|账单流水明细|账单流水)$/u, '').trim()
  if (stripped === '' || stripped === key) return fallback
  return stripped
}

/**
 * 来源面板每封邮件右侧那颗徽标（设计稿 06 §一·来源面板）。
 * 顺序有讲究：先说「你得动手」，再说「解析出多少」，最后才是「没事了」。
 */
export function mailStateBadge(task: BillTask): { label: string; kind: ChipKind } {
  const a = task.attributes
  if (a.status === 'needs_secret') return { label: '待解锁', kind: 'warn' }
  if (a.status === 'failed' || a.status === 'unknown') return { label: '解析失败', kind: 'danger' }

  const counts = a.row_counts
  if (counts.pending > 0) return { label: `解析出 ${counts.pending} 笔`, kind: 'ok' }
  if (counts.total > 0) return { label: '已入账完', kind: 'muted' }
  return TASK_STATUS_META[a.status]
}

/** 邮件主题：后端把它放在 summary 里，空的时候退回渠道名，别露出「任务 #12」 */
export function mailSubject(task: BillTask, channelLabel: string): string {
  const summary = (task.attributes.summary ?? '').trim()
  return summary || channelLabel
}

/** 忽略原因（后端 dismissed_reason）翻成人话，摆在「已忽略」每行行尾 */
export const DISMISS_REASON_LABELS: Record<string, string> = {
  user: '手动忽略',
  duplicate_auto: '判定重复',
  duplicate_confirmed: '并进另一笔',
  zero_amount: '0 元',
  task_archived: '整封邮件被忽略',
}

export function dismissReasonLabel(reason: string | null | undefined): string {
  const key = (reason ?? '').trim()
  if (key === '') return '手动忽略'
  return DISMISS_REASON_LABELS[key] ?? key
}

/**
 * 窄屏第二行那句话：渠道 · 时间 · 状态。
 *
 * 宽屏上这三样各占一列，窄屏排不下就都藏了，结果一行只剩商户和金额——
 * 同一家店同一个金额刷两次就分不出谁是谁。收成一句放在第二行。
 */
export function narrowMetaLine(a: BillQueueRow['attributes'], badgeLabel?: string): string {
  const channel = a.task ? channelDisplayName(a.task.source) : ''
  const time = (a.occurred_at ?? '').slice(11, 16)
  return [channel, time, badgeLabel].filter((part) => (part ?? '').trim() !== '').join(' · ')
}

export function syncResultFeedback(
  attributes: BillMailboxSyncResult,
): { kind: 'success' | 'inbox' | 'error'; message: string } {
  const error = attributes.errors?.find((value): value is string => typeof value === 'string' && value.trim() !== '')
  if (error) return { kind: 'error', message: error }

  const failed = attributes.failed + attributes.process_failed
  if (failed > 0) return { kind: 'error', message: `同步失败 ${attributes.failed}，解析失败 ${attributes.process_failed}` }
  if (attributes.scanned === 0) return { kind: 'success', message: '检查完成：没有新邮件' }

  const matched = attributes.matched ?? attributes.created
  const unclassified = attributes.unclassified ?? attributes.ignored
  return {
    kind: unclassified > 0 ? 'inbox' : 'success',
    message: `检查 ${attributes.scanned} 封，匹配账单 ${matched} 封，未归类 ${unclassified} 封`,
  }
}

/** 常见币种代码 → 符号。认不出的原样前置代码（「KRW 1,200」比「1,200」强）。 */
const CURRENCY_SYMBOLS: Record<string, string> = {
  CNY: '¥',
  RMB: '¥',
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  HKD: 'HK$',
  TWD: 'NT$',
  SGD: 'S$',
  AUD: 'A$',
  KRW: '₩',
}

/**
 * 金额前面印什么。后端有时只给 currency_code，直接印出来就是「CNY69.00」——
 * 记账界面上没人这么读钱。认得的币种换符号，认不得的把代码和数字隔开。
 */
export function currencyPrefix(a: Pick<BillQueueRow['attributes'], 'currency_symbol' | 'currency_code'>): string {
  const symbol = (a.currency_symbol ?? '').trim()
  const code = (a.currency_code ?? '').trim().toUpperCase()
  if (symbol && symbol !== code) return symbol
  if (!code) return ''
  return CURRENCY_SYMBOLS[code] ?? `${code} `
}

/** 同上，给只有一个币种串（可能是符号也可能是代码）的调用方 */
export function currencyPrefixOf(value: string | null | undefined): string {
  const raw = (value ?? '').trim()
  if (!raw) return ''
  const upper = raw.toUpperCase()
  if (CURRENCY_SYMBOLS[upper]) return CURRENCY_SYMBOLS[upper]
  return /^[A-Za-z]{3}$/.test(raw) ? `${upper} ` : raw
}

/**
 * 收支方向。后端在不同渠道上给的是「支出」也可能是 `out`/`in`，
 * 直接印到界面上就是一个英文单词摆在中文行里。
 */
export function directionLabel(direction: string | null | undefined): string {
  const raw = (direction ?? '').trim()
  if (raw === '' ) return '--'
  if (raw === 'out' || raw === 'withdrawal' || raw === 'debit') return '支出'
  if (raw === 'in' || raw === 'deposit' || raw === 'credit') return '收入'
  if (raw === 'transfer') return '转账'
  return raw
}

/** 原始 direction 字段（中文）映射语义色的 Tailwind 文字类：支出/收入/转账，其余（不计收支等）中性 */
export function directionColorClass(direction: string | null | undefined): string {
  const label = directionLabel(direction)
  if (label === '支出') return 'text-[var(--danger)] '
  if (label === '收入') return 'text-[var(--done)] '
  if (label === '转账') return 'text-[var(--brand-text)] '
  return 'text-[var(--text-secondary)] '
}

export function directionSign(direction: string | null | undefined): '' | '+' | '-' {
  const label = directionLabel(direction)
  if (label === '支出') return '-'
  if (label === '收入') return '+'
  return ''
}

function isValidCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]|$)/.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
}

/**
 * 行是否可勾选入账：只允许后端能够完整入账的 pending/unique 草稿。
 *
 * 批次七起不再排除「账户没对上」的行：渠道没有账户时服务端入账那一刻会替人
 * 建一个同名账户，这些行本来就入得进去，拦下来反而是凭空造了一道门槛。
 */
export function isRowSelectable(row: BillQueueRow): boolean {
  const a = row.attributes
  const date = a.firefly_date ?? a.occurred_at
  const description = a.firefly_description || (a as { description?: string | null }).description || a.counterparty
  try {
    return a.status === 'pending'
      && a.duplicate_state === 'unique'
      && !!a.firefly_type
      && !!date?.trim()
      && isValidCalendarDate(date)
      && !!a.firefly_amount?.trim()
      && isPositiveDecimal(a.firefly_amount)
      && !!description?.trim()
      && !!a.source_name?.trim()
      && !!a.destination_name?.trim()
  } catch {
    return false
  }
}

/** 非「待入账」行右侧的说明 chip：重复/冲突/已入账/失败/需拆分/已拆分/已忽略 */
export function rowBadge(row: BillQueueRow): { label: string; kind: ChipKind } | null {
  const a = row.attributes
  if (a.status === 'imported') return { label: '已入账', kind: 'muted' }
  if (a.status === 'dismissed') return { label: '已忽略', kind: 'muted' }
  if (a.status === 'failed') return { label: '入账失败', kind: 'danger' }
  if (a.status === 'needs_split') return { label: '需拆分', kind: 'warn' }
  if (a.status === 'split') return { label: '已拆分', kind: 'muted' }
  if (a.duplicate_state === 'duplicate') return { label: '重复', kind: 'muted' }
  if (a.duplicate_state === 'conflict') return { label: '冲突', kind: 'warn' }
  return null
}

/**
 * 「待确认」的分小节，依据是服务端下发的 `attention_kind`。
 *
 * 这里以前按中文 reason 子串归类（`reasons.includes('转账')`）。文案改一个字
 * 就整节掉进「其他」，而「入账前需要选择 Firefly 账户。」这句压根不含任何
 * 关键词——15 笔全掉进了「其他」。分类依据必须是 code，不是给人看的句子。
 */
export type AttentionKind =
  | 'account_unmapped'
  | 'pairing_suggested'
  | 'duplicate_suspect'
  | 'import_failed'
  | 'import_pending'
  | 'needs_fix'

const ATTENTION_KINDS: AttentionKind[] = [
  'account_unmapped',
  'pairing_suggested',
  'duplicate_suspect',
  'import_failed',
  'import_pending',
  'needs_fix',
]

/**
 * 每一节的标题和一句说明。说明要答两件事：确认什么、确认完会怎样。
 * 只写「疑似重复 3」的分节等于把判断题原样丢回给用户。
 */
export const ATTENTION_SECTIONS: { kind: AttentionKind; label: string; hint: string }[] = [
  {
    kind: 'account_unmapped',
    label: '账户对不准',
    hint: '账户信息同时像好几个账户，无法自动选定。在设置里指定一个，这一渠道以后都按它入账。',
  },
  {
    kind: 'pairing_suggested',
    // 这一节的说明是随内容变的（同渠道 / 跨渠道 / 两种都有），真正上屏的是
    // copy.pairSectionHint(pairScopeOf(...))。这里留兜底那一句，不再自己写一份，
    // 免得两处措辞各飘各的。
    label: '疑似同一笔',
    hint: pairSectionHint('mixed'),
  },
  {
    kind: 'duplicate_suspect',
    label: '疑似重复',
    hint: '和账本里已有的交易相近。标记为不是重复即可入账，确认重复则忽略、不再出现。',
  },
  {
    kind: 'import_failed',
    label: '入账失败',
    hint: '这笔入账没成功，账本里没有它。修正后重试，成功即进入已入账。',
  },
  {
    kind: 'import_pending',
    label: '结果待核实',
    hint: '已发出但没收到回执，账本里可能已经记上。核实一遍：已记上归入已入账，没记上可以重试。',
  },
  {
    kind: 'needs_fix',
    label: '需修正',
    hint: '日期、金额、类型或描述还缺一项，补齐后才能入账。',
  },
]

export function attentionSectionMeta(kind: AttentionKind) {
  return ATTENTION_SECTIONS.find((section) => section.kind === kind) ?? ATTENTION_SECTIONS[ATTENTION_SECTIONS.length - 1]
}

/** 行上有没有某个结构化问题 */
export function hasIssue(row: BillQueueRow, code: string): boolean {
  return (row.attributes.issues ?? []).some((issue) => issue.code === code)
}

function issueCodes(row: BillQueueRow): string[] {
  return (row.attributes.issues ?? [])
    .map((issue) => issue.code)
    .filter((code): code is string => typeof code === 'string')
}

function isAttentionKind(value: unknown): value is AttentionKind {
  return typeof value === 'string' && (ATTENTION_KINDS as string[]).includes(value)
}

/**
 * 分节归属。服务端下发 `attention_kind` 就用它；没下发（老服务端）时按
 * issue code、import_attempt、duplicate_state 这些结构化字段判，
 * 绝不回头去匹配中文文案。
 */
export function attentionKindOf(row: BillQueueRow): AttentionKind {
  const a = row.attributes
  if (isAttentionKind(a.attention_kind)) return a.attention_kind

  const codes = issueCodes(row)
  if (codes.includes('pair_suggested')) return 'pairing_suggested'
  if (codes.includes('duplicate_suspect')) return 'duplicate_suspect'
  if (codes.includes('import_failed')) return 'import_failed'

  const attempt = a.import_attempt
  if (attempt?.status === 'uncertain' || attempt?.status === 'prepared' || attempt?.status === 'sending') {
    return 'import_pending'
  }
  if (attempt?.status === 'retryable' || attempt?.status === 'rejected' || a.status === 'failed') {
    return 'import_failed'
  }

  if (a.duplicate_state === 'duplicate' || a.duplicate_state === 'conflict') return 'duplicate_suspect'
  return 'needs_fix'
}

export function groupAttentionRows(
  rows: BillQueueRow[],
): { kind: AttentionKind; label: string; hint: string; rows: BillQueueRow[] }[] {
  const byKind = new Map<AttentionKind, BillQueueRow[]>()
  for (const row of rows) {
    const kind = attentionKindOf(row)
    const list = byKind.get(kind)
    if (list) list.push(row)
    else byKind.set(kind, [row])
  }
  return ATTENTION_SECTIONS
    .map((section) => ({ ...section, rows: byKind.get(section.kind) ?? [] }))
    .filter((section) => section.rows.length > 0)
}

/** 一个渠道下的邮件。收件箱首屏和「邮件处理」二级页共用同一份。 */
export interface SourceGroup {
  key: string
  label: string
  platform: PlatformKey
  tasks: BillTask[]
}

/**
 * 渠道分组。渠道以 summary 为准而不是以邮件为准：某个渠道这会儿没有解析中的
 * 邮件、它名下的流水还在队列里时，chip 不能因此消失——否则「只看招行」这条路
 * 会时有时无。
 */
export function buildSourceGroups(
  tasks: BillTask[],
  channels: { key: string; name?: string | null }[],
): SourceGroup[] {
  const open = tasks.filter((task) => !CLOSED_TASK_STATUSES.includes(task.attributes.status))
  const byChannel = new Map<string, BillTask[]>()
  for (const channel of channels) byChannel.set(channel.key, [])
  for (const task of open) {
    const key = task.attributes.source
    const list = byChannel.get(key)
    if (list) list.push(task)
    else byChannel.set(key, [task])
  }
  const nameOf = (key: string) =>
    channelDisplayName(key, channels.find((channel) => channel.key === key)?.name)
  return Array.from(byChannel.entries())
    .map(([key, list]) => ({
      key,
      label: nameOf(key) || SOURCE_FALLBACK_LABELS[key] || key,
      platform: (key in BRAND_MARKS ? key : 'other') as PlatformKey,
      // 新邮件在上：找「刚同步下来的那封」比找三个月前那封频繁得多
      tasks: [...list].sort((a, b) =>
        (b.attributes.received_at ?? '').localeCompare(a.attributes.received_at ?? '')),
    }))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'))
}

/* ------------------------------------------------------------------ *
 * 配对：一对当一张卡，不是两条各自带一个子面板
 *
 * 「疑似同一笔」天然是一件双人的事：微信记了一次、银行卡又记了一次，要判的
 * 是这两条是不是一件事。原来的做法是两条独立行各挂一个「看这两笔」，同一个
 * 判断在屏幕上出现两遍，点开哪一条都在讲同一件事，还得自己认出它俩是一对。
 * 这里把一对折成一条条目，落单的（对侧已经入账或忽略）退回普通行。
 * ------------------------------------------------------------------ */

/** 行上挂着的配对。link_id 空的当没有——服务端老响应里这个字段整个是 null。 */
export function pairOf(row: BillQueueRow): BillRowPair | null {
  const pair = row.attributes.pair
  return pair && pair.link_id ? pair : null
}

/** 已经并成一条的行：强证据自动合的，或者人确认过的 */
export function isMergedRow(row: BillQueueRow): boolean {
  return pairOf(row)?.state === 'confirmed'
}

/** 系统自己合的那一批。可见可拆的要求只落在这上面。 */
export function isAutoMerged(row: BillQueueRow): boolean {
  const pair = pairOf(row)
  return pair?.state === 'confirmed' && pair.decided_by === 'auto'
}

/** 这一行来自哪个渠道。行上没有 channel_key，来源邮件的 source 就是它。 */
export function rowChannelKey(row: BillQueueRow): string {
  return row.attributes.task?.source ?? ''
}

export type PairEntry =
  | { kind: 'pair'; key: string; linkId: string; left: BillQueueRow; right: BillQueueRow }
  /** orphan：这一行有配对建议，但对侧不在这批里（已入账 / 已忽略 / 翻页翻掉了） */
  | { kind: 'single'; key: string; row: BillQueueRow; orphan: boolean }

/**
 * 把「疑似同一笔」那一节的行折成条目。顺序按原始行序，一对认第一条出现的位置。
 */
export function buildPairEntries(rows: BillQueueRow[]): PairEntry[] {
  const byLink = new Map<string, BillQueueRow[]>()
  for (const row of rows) {
    const pair = pairOf(row)
    if (!pair) continue
    const list = byLink.get(pair.link_id)
    if (list) list.push(row)
    else byLink.set(pair.link_id, [row])
  }

  const done = new Set<string>()
  const out: PairEntry[] = []
  for (const row of rows) {
    const pair = pairOf(row)
    if (!pair) {
      out.push({ kind: 'single', key: row.id, row, orphan: false })
      continue
    }
    if (done.has(pair.link_id)) continue
    const both = byLink.get(pair.link_id) ?? []
    if (both.length >= 2) {
      done.add(pair.link_id)
      out.push({ kind: 'pair', key: `pair-${pair.link_id}`, linkId: pair.link_id, left: both[0], right: both[1] })
    } else {
      done.add(pair.link_id)
      out.push({ kind: 'single', key: row.id, row, orphan: true })
    }
  }
  return out
}

/** 这条流水的某个字段是不是 AI 建议的（设计稿 03 §3） */
export function isAiSuggested(row: BillQueueRow): boolean {
  const a = row.attributes
  return !!a.suggested_by && !a.user_modified_at
}

/** 还没被 AI 碰过、也没被人改过的 pending 行——「生成填写建议」按钮的显示条件 */
export function needsAutofill(row: BillQueueRow): boolean {
  const a = row.attributes
  if (a.status !== 'pending') return false
  if (a.suggested_by || a.user_modified_at) return false
  return !a.category_name?.trim() || !a.firefly_description?.trim() || !a.notes?.trim()
}

export function rowDescription(a: BillQueueRow['attributes']): string {
  const text = (value: unknown): string => (typeof value === 'string' ? value : '')
  return (
    text(a.firefly_description)
    || text(a.counterparty)
    || text((a as { description?: unknown }).description)
    || '--'
  )
}

export function rowAmount(a: BillQueueRow['attributes']): string {
  const raw = a.firefly_amount ?? a.amount
  return raw == null || raw === '' ? '0' : String(raw)
}

export function rowDate(a: BillQueueRow['attributes']): string | null {
  return a.firefly_date ?? a.occurred_at
}

/**
 * 一笔流水该挂哪个平台标。
 *
 * 找的顺序是有讲究的：先看描述和对手方（「支付宝-上海盒马」这种前缀最准），
 * 再看账户里那几个钱包产品（花呗、余额宝、云闪付），最后才退回这封邮件的渠道。
 * 不能一上来就看账户 —— 招行账单里每一行的账户都写着「招商银行信用卡」，
 * 那样整箱流水会全变成招行标，等于没标。
 */
const DESCRIPTION_HINTS: { key: BrandKey; patterns: string[] }[] = [
  { key: 'huabei', patterns: ['花呗'] },
  { key: 'tenpay', patterns: ['财付通'] },
  { key: 'alipay', patterns: ['支付宝', '余额宝', '蚂蚁'] },
  { key: 'wechat', patterns: ['微信'] },
  { key: 'unionpay', patterns: ['云闪付', '银联'] },
  { key: 'douyin', patterns: ['抖音'] },
  { key: 'meituan', patterns: ['美团'] },
  { key: 'pdd', patterns: ['拼多多'] },
  { key: 'jd', patterns: ['京东'] },
  { key: 'apple', patterns: ['Apple', 'iCloud', 'iTunes', 'App Store'] },
  { key: 'cmb', patterns: ['招商银行', '招行'] },
  { key: 'boc', patterns: ['中国银行'] },
]

/** 账户名里只认这几个钱包产品；银行名故意不认，理由见上 */
const ACCOUNT_HINTS: { key: BrandKey; patterns: string[] }[] = [
  { key: 'huabei', patterns: ['花呗'] },
  { key: 'alipay', patterns: ['余额宝', '支付宝'] },
  { key: 'wechat', patterns: ['微信', '零钱'] },
  { key: 'unionpay', patterns: ['云闪付'] },
]

function matchHint(text: string, table: { key: BrandKey; patterns: string[] }[]): BrandKey | null {
  const lower = text.toLowerCase()
  for (const hint of table) {
    if (hint.patterns.some((pattern) => lower.includes(pattern.toLowerCase()))) return hint.key
  }
  return null
}

export function rowPlatform(a: BillQueueRow['attributes']): PlatformKey {
  const described = matchHint(`${rowDescription(a)} ${a.counterparty ?? ''}`, DESCRIPTION_HINTS)
  if (described) return described

  const account = matchHint(`${a.source_name ?? ''} ${a.destination_name ?? ''}`, ACCOUNT_HINTS)
  if (account) return account

  const channel = a.task?.source
  if (channel && channel in BRAND_MARKS) return channel as BrandKey
  return 'other'
}

/**
 * 行上显示的商户名：平台前缀交给左边那枚标去说，描述里就别再印一遍。
 * 只砍「平台-」这一种前缀，砍完是空的就退回原文 —— 宁可重复，也不能把整行说没了。
 */
export function rowMerchant(a: BillQueueRow['attributes']): string {
  const text = rowDescription(a)
  const dash = text.search(/[-－—]/u)
  if (dash <= 0) return text
  const prefix = text.slice(0, dash)
  if (!matchHint(prefix, DESCRIPTION_HINTS)) return text
  const rest = text.slice(dash + 1).trim()
  return rest || text
}

/**
 * 行上那一格账户显示谁：钱从哪个账户出（支出）／进了哪个账户（收入）。
 * 另一端不是商户就是同一个户头，描述里已经有了。
 */
export function fundingAccount(a: BillQueueRow['attributes']): string {
  const source = (a.source_name ?? '').trim()
  const destination = (a.destination_name ?? '').trim()
  if (directionLabel(a.direction) === '收入') return destination || source || '--'
  return source || destination || '--'
}

/** 一行的带符号金额，用来算当日合计：支出记负、收入记正、其余（转账等）不计 */
export function signedAmount(a: BillQueueRow['attributes']): number {
  const value = Number(rowAmount(a))
  if (!Number.isFinite(value)) return 0
  const label = directionLabel(a.direction)
  if (label === '支出') return -value
  if (label === '收入') return value
  return 0
}

/** 一个币种的小计。多币种不换算，分开列。 */
export interface CurrencyTotal {
  /** 币种代码（CNY / USD…），没有就退回符号 */
  code: string
  /** 显示用符号，缺省退回代码 */
  symbol: string
  expense: number
  income: number
  /** 带符号净额：收入 - 支出 */
  net: number
}

function currencyKeyOf(a: BillQueueRow['attributes']): { code: string; symbol: string } {
  const code = (a.currency_code ?? '').trim()
  const symbol = (a.currency_symbol ?? '').trim()
  return { code: code || symbol, symbol: symbol || code }
}

/**
 * 按币种把一组行加起来。原来是直接 `Number(amount)` 全部相加：
 * 68 美元的订阅和 68 元的午饭在一条工作量条上被当成 136，日合计同理。
 */
export function sumByCurrency(rows: BillQueueRow[]): CurrencyTotal[] {
  const buckets = new Map<string, CurrencyTotal>()
  for (const row of rows) {
    const a = row.attributes
    const { code, symbol } = currencyKeyOf(a)
    const bucket = buckets.get(code) ?? { code, symbol, expense: 0, income: 0, net: 0 }
    const value = signedAmount(a)
    if (value < 0) bucket.expense -= value
    else bucket.income += value
    bucket.net += value
    buckets.set(code, bucket)
  }
  // 有金额的币种排前面，省得「¥0.00 + $12.00」把零值摆在最左
  return Array.from(buckets.values()).sort((left, right) =>
    Math.abs(right.net) - Math.abs(left.net) || left.code.localeCompare(right.code))
}

export interface DayGroup {
  /** YYYY-MM-DD */
  day: string
  rows: BillQueueRow[]
  /** 当日合计，按币种分开；分组头右端印的就是它 */
  totals: CurrencyTotal[]
}

/**
 * 按日期分组。日期从每一行搬到分组头上：一封招行日账单解析出九笔，
 * 原来就是把同一个「08-08」原样印九遍。
 *
 * 保持行本来的先后顺序，不重排 —— 后端已经排过一次了。
 */
export function groupRowsByDay(rows: BillQueueRow[]): DayGroup[] {
  const groups: DayGroup[] = []
  const index = new Map<string, DayGroup>()
  for (const row of rows) {
    const day = (rowDate(row.attributes) ?? '').slice(0, 10) || '--'
    let group = index.get(day)
    if (!group) {
      group = { day, rows: [], totals: [] }
      index.set(day, group)
      groups.push(group)
    }
    group.rows.push(row)
  }
  for (const group of groups) group.totals = sumByCurrency(group.rows)
  return groups
}


/* ------------------------------------------------------------------ *
 * 已入账：按批次分组
 *
 * 「批次」= 一次入账动作写进去的那一组行，服务端在 import_attempt 上落了
 * batch_id。这里不拿时间窗口凑：两次相隔几秒的入账会被并成一批，一次跑了两分钟的
 * 大批量会被切成好几段，而按错的分组去撤回等于从账本里删掉不该删的交易。
 *
 * batch_id 为空的行（这个字段上线之前入的账、或者走单条重试入的账）不属于任何一批，
 * 全部落进最后那个 legacy 组，只能逐行撤销。
 * ------------------------------------------------------------------ */

export interface ImportBatchGroup {
  /** null = 没有批次编号的那一组，不给「撤回这批」 */
  batchId: string | null
  /** 这一批最早那条入账记录的时间戳（ISO），组头上印的就是它 */
  at: string | null
  rows: BillQueueRow[]
  totals: CurrencyTotal[]
}

export function batchIdOf(row: BillQueueRow): string | null {
  const id = row.attributes.import_attempt?.batch_id
  return typeof id === 'string' && id.trim() !== '' ? id : null
}

/**
 * 按批次分组。保持行本来的先后顺序，一批认它第一条出现的位置；
 * 没有批次的那一组永远排在最后——它是个杂项桶，摆在中间会把两批真批次隔开。
 */
export function groupRowsByImportBatch(rows: BillQueueRow[]): ImportBatchGroup[] {
  const groups: ImportBatchGroup[] = []
  const index = new Map<string, ImportBatchGroup>()
  const legacy: BillQueueRow[] = []

  for (const row of rows) {
    const batchId = batchIdOf(row)
    if (batchId === null) {
      legacy.push(row)
      continue
    }
    let group = index.get(batchId)
    if (!group) {
      group = { batchId, at: null, rows: [], totals: [] }
      index.set(batchId, group)
      groups.push(group)
    }
    group.rows.push(row)
    // 组头写这一批**最早**那一条的时间：一批里的 updated_at 会因为逐条写入而差上几秒，
    // 取最早的那个才是「我按下入账的那一刻」。
    const at = row.attributes.import_attempt?.updated_at ?? null
    if (at && (group.at === null || at < group.at)) group.at = at
  }
  if (legacy.length > 0) groups.push({ batchId: null, at: null, rows: legacy, totals: [] })
  for (const group of groups) group.totals = sumByCurrency(group.rows)
  return groups
}

/* ------------------------------------------------------------------ *
 * 配对：同渠道还是跨渠道
 * ------------------------------------------------------------------ */

/**
 * 这一节里的配对是同渠道的、跨渠道的，还是两种都有。
 *
 * 节说明按它分岔：「两个渠道各记了一次」摆在两条都来自招行的一对上面是句假话。
 * 落单的行（对侧不在这一屏）不参与判定——它压根摆不出两边。
 */
export function pairScopeOf(entries: PairEntry[]): 'same' | 'cross' | 'mixed' {
  let same = 0
  let cross = 0
  for (const entry of entries) {
    if (entry.kind !== 'pair') continue
    if (rowChannelKey(entry.left) === rowChannelKey(entry.right)) same += 1
    else cross += 1
  }
  if (same > 0 && cross > 0) return 'mixed'
  if (same > 0) return 'same'
  // 一对都没有（全是落单）时按跨渠道说：那是这类建议的常态。
  return 'cross'
}

/** 「-¥15.50」这种带符号金额串。金额格式化交给 formatAmount，这里只管符号和币种前缀。 */
export function formatSignedMoney(value: number, symbol: string, format: (raw: string) => string): string {
  const sign = value < 0 ? '-' : value > 0 ? '+' : ''
  return `${sign}${symbol}${format(Math.abs(value).toFixed(2))}`
}

/**
 * 「刚刚」「12 分钟前」「3 小时前」。给顶栏那个同步图标当提示用。
 *
 * 只到「天」为止：再往上（上个月、去年）对「上次同步」这件事没有意义——
 * 隔了那么久，人要看的是邮箱还连没连，不是精确差了多少天。
 */
export function relativeTimeLabel(iso: string | null | undefined, now: number = Date.now()): string | null {
  const at = Date.parse(iso ?? '')
  if (!Number.isFinite(at)) return null
  const seconds = Math.floor((now - at) / 1000)
  if (seconds < 0) return null
  if (seconds < 60) return '刚刚'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

/** 「昨天」「2 天前」；今天以内就说今天。传进来的两个都是 YYYY-MM-DD */
export function relativeDayLabel(day: string, today: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return null
  const diff = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86400000)
  if (!Number.isFinite(diff) || diff < 0) return null
  if (diff === 0) return '今天'
  if (diff === 1) return '昨天'
  return `${diff} 天前`
}

/** 「最早 6 月」：队列里最早那笔待处理流水落在哪个月 */
export function earliestMonthLabel(rows: BillQueueRow[]): string | null {
  let earliest: string | null = null
  for (const row of rows) {
    const date = rowDate(row.attributes)
    if (!date) continue
    const day = date.slice(0, 10)
    if (!earliest || day < earliest) earliest = day
  }
  if (!earliest) return null
  return `${Number(earliest.slice(5, 7))} 月`
}
