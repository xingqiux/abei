/**
 * 账单收件箱的用户可见文案。
 *
 * 收在一处的理由：同一个状态在节头、chip、横幅、toast 里各写一遍，改一个词就
 * 漏一处，界面上于是同一个状态出现两三种说法。术语表
 * （05-文案规范）里的状态词只在这里落一次，组件只引用不自造。
 *
 * 三条规矩，改这个文件时照着来：
 * 1）状态词用术语表：待入账 / 待确认 / 已忽略 / 已入账 / 待解锁 / 解析失败。
 * 2）错误说三件事：出了什么事、对用户意味着什么、现在能怎么办（动作按钮另给）。
 *    技术原文（error_code、后端英文 message）一律降为小字，不进正文。
 * 3）带变量的用函数导出，别在组件里拼字符串。
 */

/* ── 页头 ────────────────────────────────────────────────────────── */

export const PAGE_TITLE = '账单收件箱'
export const PAGE_SUBTITLE = '从邮箱账单解析出的流水；入账后进入交易。'

export const SYNC_BUTTON_IDLE = '检查新邮件'
export const SYNC_BUTTON_BUSY = '正在检查新邮件'
export const MAILBOX_SETTINGS_BUTTON = '邮箱设置'
export const AUTOFILL_BUTTON_IDLE = '生成填写建议'
export const AUTOFILL_BUTTON_BUSY = '正在生成建议…'

export function lastSyncNote(relative: string): string {
  return `上次同步${relative}`
}

/** 页头那一行里的同步按钮：图标旁边要有字，否则窄屏上是一颗无名图标 */
export const SYNC_INLINE = '同步邮件'

/* ── 二级页「邮件处理」 ──────────────────────────────────────────── *
 * 收件箱首屏只回答「还有多少笔要处理」。邮箱那头的事——收了几封、解析成了
 * 几封、哪几封在等密码——是另一个问题，搬到二级页去问。
 * ------------------------------------------------------------------ */

export const MAIL_PAGE_ENTRY = '邮件处理'
export const MAIL_PAGE_TITLE = '邮件处理'
export const MAIL_PAGE_SUBTITLE = '账单邮件走到流水这一路，每一段剩下多少、漏在哪儿。'
export const MAIL_PAGE_BACK = '返回收件箱'
export const MAIL_FUNNEL_TITLE = '这一批邮件的去向'
export const MAIL_LIST_TITLE = '邮件清单'
export const MAIL_LIST_HINT = '这批流水从哪几封邮件来的。选中一封可以解锁、重新解析或忽略。'
export const MAIL_STUCK_TITLE = '要人动手的邮件'
export const MAIL_STUCK_HINT = '按渠道和原因归成一条，展开可以逐封处理。'
export const MAIL_STUCK_EMPTY = '没有要人动手的邮件。'
export const MAIL_VIEW_ROWS = '看这封解析出的流水'

/* ── 疑似同一笔：成对卡 ──────────────────────────────────────────── */

export const PAIR_CONFIRM = '是同一笔，合并保留一条'
export const PAIR_REJECT = '不是同一笔，分开记'
export const PAIR_CONFIRM_DONE = '已合并成一条，另一笔不再单独入账'
export const PAIR_REJECT_DONE = '已记下不是同一笔，两条都保留'
export const PAIR_UNDO_DONE = '已拆开，两笔各自回到待处理'
export const PAIR_SAVE_FAILED = '没能保存这次判断，请重试'
/** 对侧那一行已经被处理掉（入账 / 忽略）时，这一条退化成普通行的说明 */
export const PAIR_ORPHAN_NOTE = '另一笔已经处理过了，这条按单笔处理。'
export const PAIR_DIFF_HEAD = '两边不一样'

/**
 * 成对卡的卡头。
 *
 * 两笔来自同一个渠道时原来写成「招商银行 · 招商银行」——同一个名字印两遍，
 * 读起来像模板没填上。同渠道那一对说清楚它是同渠道的两笔就够了。
 */
export function pairHead(here: string, there: string): string {
  return here === there ? `${here} · 同渠道两笔` : `${here} · ${there}`
}

/**
 * 「疑似同一笔」的节说明。
 *
 * 「两个渠道各记了一次」对同渠道那一对是句假话：同一个渠道里出现两条一样的流水，
 * 多半是账单重复给了同一笔，而不是两处各记一次。两种情形分开说。
 */
export function pairSectionHint(scope: 'same' | 'cross' | 'mixed'): string {
  const head = scope === 'same'
    ? '同一个渠道里出现了两条几乎一样的流水'
    : scope === 'cross'
      ? '两个渠道各记了一次，可能是同一笔消费'
      : '同一笔消费被记了两次——同渠道重复给账，或者两个渠道各记了一次'
  return `${head}。确认合并只保留一条，否掉则两条都保留、各自入账。`
}

/**
 * 并排两栏的列名。跨渠道时渠道名本身就区分得开，同渠道时两栏顶着同一个名字，
 * 得换成序数才知道左边说的是哪一笔。
 */
export const PAIR_COLUMN_FIRST = '第一笔'
export const PAIR_COLUMN_SECOND = '第二笔'

/** 「疑似同一笔」的节头计数按**对**算，和一对折成一张卡的呈现对上 */
export function pairSectionCount(pairs: number, singles: number): string {
  const parts = [pairs > 0 ? `${pairs} 对` : null, singles > 0 ? `${singles} 笔` : null]
  return parts.filter(Boolean).join(' · ')
}

/* ── 自动合并：可见、可拆 ────────────────────────────────────────── */

export const MERGED_CHIP = '已合并'
export const MERGED_SPLIT = '拆开'
export const MERGED_PANEL_TITLE = '合并前的两条'

export function mergedAutoNote(here: string, there: string): string {
  return `${here}和${there}各记了一次，订单号完全对得上，已自动合并成一条。`
}

export function mergedUserNote(here: string, there: string): string {
  return `你确认过${here}和${there}这两笔是同一笔，已合并成一条。`
}

/* ── 疑似重复：和账本里那一笔并排比 ──────────────────────────────── */

export const DUP_COMPARE_TITLE = '和账本里这一笔很像'
export const DUP_THIS_LABEL = '这一笔'
export const DUP_OTHER_LABEL = '账本里已有的'
export const DUP_MISSING = '账本里那一笔的摘要没取到，可以先按「不是重复」处理。'
export const DUP_IGNORE = '已记过，忽略这条'
export const DUP_NOT_DUPLICATE = '不是重复，照常入账'

/* ── 并排对比用的字段名 ──────────────────────────────────────────── */

export const FIELD_CHANNEL = '渠道'
export const FIELD_DATE = '日期'
export const FIELD_AMOUNT = '金额'
export const FIELD_COUNTERPARTY = '对手方'
export const FIELD_DESCRIPTION = '描述'
export const FIELD_ACCOUNT = '账户'
export const FIELD_EMPTY = '--'

/* ── 顶部横幅：都按「出了什么事 + 意味着什么」写，动作是横幅自带的重试 ── */

export const SUMMARY_ERROR = '收件箱汇总没加载出来，各处笔数可能不准'
export const SETTINGS_ERROR = '邮箱设置没加载出来，暂时判断不出邮箱连没连'
export const CHANNELS_ERROR = '渠道列表没加载出来，只能先看全部来源'
export const PIPELINE_ERROR = '邮件处理进度没加载出来'

/* ── 分节：待入账 / 待确认 / 已完成 ──────────────────────────────── */

export const SECTION_IMPORTABLE_TITLE = '待入账'
export const SECTION_IMPORTABLE_HINT = '字段齐全、没有疑点，勾选后即可入账。'
export const SECTION_IMPORTABLE_SELECT_ALL = '全选'
export const SECTION_IMPORTABLE_SELECT_ALL_LABEL = '全选待入账的流水'

export const SECTION_ATTENTION_TITLE = '待确认'
export const SECTION_ATTENTION_HINT = '这些流水确认之后才能入账，每一节写明确认什么、确认完会怎样。'

/* ── 待处理清空之后 ──────────────────────────────────────────────── *
 * 两节都空的时候摆两个「没有待入账的流水」「没有待确认的流水」，等于把一次
 * 干完的结果说成两处缺席。清完是这一层唯一值得说的事，整块换成一句话加两个出口。
 * 不用感叹号：这件事每天会发生一次，天天被恭喜一遍就成了噪音。
 * ------------------------------------------------------------------ */

export const PENDING_CLEAR_TITLE = '待处理清完了'

/** 副句的成果部分。数字取自已完成层，取不到（还没加载/接口坏了）就整句不印。 */
export function pendingClearTally(imported: number, dismissed: number): string | null {
  const parts = [
    imported > 0 ? `入账 ${imported} 笔` : null,
    dismissed > 0 ? `忽略 ${dismissed} 笔` : null,
  ].filter(Boolean)
  return parts.length === 0 ? null : `已经${parts.join('、')}`
}

export const PENDING_CLEAR_GOTO_DONE = '看已完成'
export const PENDING_CLEAR_SYNC = '同步邮件'

export const SECTION_IMPORTED_HINT = '已经记进账本的流水。要改要删去交易页，收件箱这里不会再动它。'
export const SECTION_DISMISSED_HINT = '这些流水不会入账。恢复之后按状态回到待处理。'

export const DONE_SEGMENT_LABEL = '已完成的两类'

/* ── 已入账：按批次分组 ──────────────────────────────────────────── *
 * 一批就是一次入账动作写进去的那几行。按日期分组回答不了「我刚才那一下入了
 * 哪几笔」——同一天可以入好几次，一次也可以横跨好几天的流水。
 * ------------------------------------------------------------------ */

/** 组头的笔数与合计。合计按币种分开，由调用方拼好传进来。 */
export function batchHeadCount(count: number): string {
  return `入账 ${count} 笔`
}

/** 这一批没有批次编号（这个功能上线之前入的账），只能逐行撤销 */
export const BATCH_LEGACY_TITLE = '更早的入账'
export const BATCH_LEGACY_HINT = '这些流水入账时还没有记批次，只能逐行撤销。'

export const BATCH_UNDO = '撤回这批'
export const BATCH_UNDO_BUSY = '撤回中…'

export function batchUndoTitle(count: number): string {
  return `撤回这批 ${count} 笔`
}

export function batchUndoBody(count: number): string {
  return `这 ${count} 笔会从账本删除并回到待处理。`
}

export const BATCH_UNDO_NOTE = '账本里对应的交易一并删掉。已经在交易页改过的那几笔也一样会被删。'
export const BATCH_UNDO_CONFIRM = '撤回并删除'

/** 节头上的「已显示 N / 共 M 笔」。加载中或加载失败时不印——那时候数字是假的。 */
export function sectionCount(shown: number, total: number): string {
  return `已显示 ${shown} / 共 ${total} 笔`
}

/* ── 列表加载 / 空态 / 错误 ──────────────────────────────────────── */

export function listLoadingLabel(what: string): string {
  return `${what}的流水加载中`
}

/** 区块内联错误：只报这一块没成，别拿整屏的大图标顶掉列表 */
export const LIST_ERROR = '这部分没加载出来'
export const RETRY_BUTTON = '重试'

export const EMPTY_IMPORTABLE = '没有待入账的流水'
export const EMPTY_ATTENTION = '没有待确认的流水。'
export const EMPTY_IMPORTED = '还没有入账过流水'
export const EMPTY_DISMISSED = '还没有忽略过流水'
export const EMPTY_GOTO_PENDING = '看待处理的'

export function loadMoreNote(loading: boolean, shown: number, total: number): string {
  return loading
    ? `正在加载…${sectionCount(shown, total)}`
    : `到底了 · ${sectionCount(shown, total)}`
}

/* ── 筛选说明 ────────────────────────────────────────────────────── */

export function filterNoteMail(subject: string): string {
  return `只看：${subject}`
}

export function filterNoteChannel(channel: string): string {
  return `只看：${channel}`
}

export const FILTER_NOTE_FALLBACK_MAIL = '这封邮件'
export const FILTER_CLEAR = '看全部'

/* ── 批量操作 ────────────────────────────────────────────────────── */

export function importButton(count: number): string {
  return `入账 ${count} 笔`
}

export const IMPORT_BUTTON_BUSY = '入账中…'

export function dismissButton(count: number): string {
  return `忽略 ${count} 笔`
}

export function selectedCountNote(count: number): string {
  return `已选 ${count} 笔`
}

export const CANCEL_SELECTION = '取消'

/** 操作类 toast 上那颗可点的撤销（05 §toast）。入账、忽略共用同一个词。 */
export const TOAST_UNDO = '撤销'

export function confirmImportTitle(count: number): string {
  return `确认入账 ${count} 笔`
}

export const KEYBOARD_HINT_FULL = '键盘：j/k 上下 · x 勾选 · e 编辑 · d 忽略 · Enter 入账'
export const KEYBOARD_HINT_BROWSE = '键盘：j/k 上下浏览'

export function aiSuggestedNote(count: number): string {
  return `其中 ${count} 笔带 AI 建议`
}

/* ── 管道条 ──────────────────────────────────────────────────────── */

export const PIPELINE_QUIET = '没有收到新的账单邮件。'
export const PIPELINE_SYNCING = '正在检查新邮件…'

export function pipelineWaiting(count: number): string {
  return `待解锁 ${count} 封`
}

export function pipelineRunning(count: number): string {
  return `正在解析 ${count} 封`
}

export function pipelineFailed(count: number): string {
  return `解析失败 ${count} 封`
}

/** 待解锁那条聚合横幅的正文：N 封哪个渠道的账单在等密码 */
export function stuckWaitingText(count: number, channel: string): string {
  return `${count} 封${channel}账单在等解压密码`
}

export function stuckFailedText(count: number, channel: string): string {
  return `${count} 封${channel}账单没解析出来`
}

export const STUCK_UNLOCK_ACTION = '去解锁'
export const STUCK_DETAIL_ACTION = '查看详情'
export const STUCK_DETAIL_ACTION_OPEN = '收起详情'
export const RETRY_PARSE = '重新解析'
export const RETRY_PARSE_QUEUED = '已重新排队解析'

export function retryParseFailed(detail?: string): string {
  return detail ? `重试没能提交：${detail}` : '重试没能提交'
}

/* ── 错误码 → 人话 ───────────────────────────────────────────────── *
 * 这两张表是「错误码永不直出」的落点。正文永远是这里的句子，后端给的
 * error_code / error_message 只当小字细节挂在正文下面。表里没有的码不算意外，
 * 走各自的兜底句——直出一个 `secret_required` 比说「没解析出来」更糟。
 * ------------------------------------------------------------------ */

const WAITING_REASON_TEXT: Record<string, string> = {
  secret_required: '在等账单解压密码',
  secret_rejected: '密码不对，要重新提供',
  password_required: '在等账单解压密码',
}

export function waitingReasonText(reason: string | null | undefined): string {
  const key = (reason ?? '').trim()
  return WAITING_REASON_TEXT[key] ?? '在等账单解压密码'
}

const PARSE_ERROR_TEXT: Record<string, string> = {
  secret_required: '在等账单解压密码',
  secret_rejected: '密码不对，要重新提供',
  attachment_missing: '邮件里没找到账单附件',
  unsupported_format: '这份账单的格式还不支持',
  parse_failed: '账单内容没解析出来',
  timeout: '解析超时了',
}

/** 解析失败：正文一句人话，技术原文（码或英文 message）单独返回，界面上降为小字 */
export function parseErrorText(
  code: string | null | undefined,
  message?: string | null,
): { text: string; detail: string | null } {
  const key = (code ?? '').trim()
  const known = PARSE_ERROR_TEXT[key]
  const detail = [message?.trim(), key].filter((part) => (part ?? '') !== '').join(' · ')
  return { text: known ?? '没解析出来', detail: detail || null }
}

/* ── 邮件清单（管道条展开层） ────────────────────────────────────── */

export const MAILS_EMPTY = '最近没有还在处理中的账单邮件。已经解析完的邮件不再列在这里。'
export const CHANNELS_EMPTY = '没有解析中的账单邮件，可在右上角同步邮件。'
export const CHANNEL_ALL = '全部来源'

export function moreMails(count: number): string {
  return `还有 ${count} 封`
}

export const MAILS_COLLAPSE = '收起邮件'

export const MAIL_UNLOCK_FIELD_LABEL = '解压密码'
export const MAIL_UNLOCK_FIELD_HINT = '提交后重新解析附件'
export const MAIL_UNLOCK_BUTTON = '解锁'
export const MAIL_UNLOCK_BUTTON_BUSY = '解锁中…'
export const MAIL_UNLOCK_EMPTY = '请输入密码或验证码'
export const MAIL_PARSE_FAILED = '解析这封邮件时出错，流水没有生成。'
export const MAIL_PICKED_NOTE = '只看这封邮件解析出的流水。'
export const MAIL_IGNORE = '忽略这封邮件'

/* ── 行内 ────────────────────────────────────────────────────────── */

export const ROW_IMPORT = '入账'
export const ROW_EDIT = '编辑'
export const ROW_DISMISS = '忽略这笔'
export const ROW_RESTORE = '恢复'
export const ROW_VIEW_TRANSACTION = '查看交易'
export const ROW_RECONCILE = '核实结果'
export const ROW_RETRY_IMPORT = '重试入账'
export const ROW_NOT_DUPLICATE = '不是重复'
export const ROW_SPLIT = '拆成多笔'
export const ROW_PAIR_OPEN = '看这两笔'
export const ROW_PAIR_CLOSE = '收起这两笔'

export const ROW_DETAIL_ERROR = '这笔处理时出错'
export const ROW_DETAIL_IMPORT_ERROR = '入账没成功'

/** 入账尝试的状态。认不出的状态不直出英文，给一句兜底并把原文降为小字。 */
export function importAttemptStatusText(status: string): { text: string; detail: string | null } {
  const map: Record<string, string> = {
    prepared: '已准备，等待入账',
    sending: '正在入账',
    uncertain: '结果待核实，账本里可能已经记上',
    retryable: '入账失败，可以重试',
    rejected: '账本没有接受这笔',
    reconciled: '已核实',
    succeeded: '已入账',
    undone: '入账已撤销，这一行放回待处理',
  }
  const known = map[status]
  return known ? { text: known, detail: null } : { text: '入账状态未知', detail: status || null }
}
