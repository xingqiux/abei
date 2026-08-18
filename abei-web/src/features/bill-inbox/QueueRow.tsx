import { useRef, useState, type ReactNode } from 'react'
import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react'
import { CaretRight, DotsThree } from '@phosphor-icons/react'
import { Link } from '@tanstack/react-router'
import type { BillQueueRow } from '../../api/schemas'
import { useBillRowLinkDecision, useMarkBillRowUnique, useUpdateBillStatementRow } from '../../api/queries'
import { StatusChip } from '../../components/abei/StatusChip'
import { showToast } from '../../store/toastStore'
import { formatAmount } from '../../lib/format'
import { AbeiApiError } from '../../api/client'
import {
  channelDisplayName,
  currencyPrefix,
  currencyPrefixOf,
  directionColorClass,
  directionLabel,
  directionSign,
  dismissReasonLabel,
  hasIssue,
  fundingAccount,
  isAiSuggested,
  isMergedRow,
  narrowMetaLine,
  pairOf,
  rowAmount,
  rowBadge,
  rowDate,
  rowDescription,
  rowMerchant,
  rowPlatform,
  type AttentionKind,
  type InboxView,
} from './billInboxHelpers'
import * as copy from './copy'
import { PlatformMark } from './PlatformMark'
import { BRAND_MARKS, type PlatformKey } from './brandMarks'
import { CompareTable, type CompareField } from './CompareTable'
import { PairingSuggestions } from './PairingSuggestions'
import { RowPairPanel } from './PairCard'
import { QueueRowEditor } from './QueueRowEditor'
import { RowTimeline } from './RowTimeline'
import { SplitBillRowDialog } from './SplitBillRowDialog'
import { TaskEvidencePanel } from './TaskEvidencePanel'
import { Button, IconButton } from '../../components/ui/Button'
import { DROPDOWN_ITEM } from '../../components/ui/Dropdown'
import { txSearch } from '../../routes/transactionSearch'

/**
 * AI 建议的值：品牌色 soft 底 + 虚线下划线（设计稿 03 §3）。
 * 人改过之后后端会清 suggested_by，这里自动退回普通样式。
 */
function AiValue({ ai, children }: { ai: boolean; children: ReactNode }) {
  if (!ai) return <>{children}</>
  return (
    <span
      title="AI 建议，入账即确认"
      className="rounded-[3px] border-b border-dashed border-[var(--brand)] bg-[var(--brand-soft)] px-1"
    >
      {children}
      <span className="sr-only">（AI 建议，入账即确认）</span>
    </span>
  )
}

/**
 * 分类格。AI 建议的分类走虚线边框 chip（设计稿 06 §一·主区队列），
 * 一眼能和人确认过的分类分开；人改过之后退回实心。
 */
function CategoryCell({ label, ai }: { label: string; ai: boolean }) {
  return (
    <span
      title={ai ? 'AI 建议，入账即确认' : undefined}
      className={`inline-flex h-[18px] max-w-full items-center truncate rounded-md px-2 text-[11px] ${
        ai
          ? 'border border-dashed border-[var(--brand)] bg-[var(--brand-soft)] text-[var(--brand-text)]'
          : 'bg-[var(--surface-hover)] text-[var(--text-secondary)]'
      }`}
    >
      {label}
      {ai && <span className="sr-only">（AI 建议）</span>}
    </span>
  )
}

export type QueueRowMode = InboxView

export function QueueRow({
  row,
  mode,
  attentionKind,
  selected = false,
  selectable = false,
  onSelect,
  focused = false,
  expanded,
  onToggleExpand,
  editing,
  onStartEdit,
  onEndEdit,
  onDismiss,
  onRestore,
  onReconcile,
  onRetryImport,
  onImport,
  onSplitDialogChange,
  busy = false,
}: {
  row: BillQueueRow
  mode: QueueRowMode
  attentionKind?: AttentionKind
  selected?: boolean
  selectable?: boolean
  /** shift 为真表示区间选（从上一次点的那行选到这行） */
  onSelect?: (shift: boolean) => void
  focused?: boolean
  expanded: boolean
  onToggleExpand: () => void
  editing: boolean
  onStartEdit: () => void
  onEndEdit: () => void
  onDismiss?: () => void
  onRestore?: () => void
  onReconcile?: () => void
  onRetryImport?: () => void
  /** 只入这一笔。给的是「这行自己就能入账」的行，批量按钮之外的单行出口。 */
  onImport?: () => void
  /** 拆分弹窗开合要往上报：页面靠它整体停用全局快捷键 */
  onSplitDialogChange?: (open: boolean) => void
  busy?: boolean
}) {
  const a = row.attributes
  const badge = rowBadge(row)
  const ai = isAiSuggested(row)
  const reasons = a.reasons ?? []
  const importAttempt = a.import_attempt
  const isDuplicateSuspect = a.duplicate_state === 'duplicate'
    || a.duplicate_state === 'conflict'
    || hasIssue(row, 'duplicate_suspect')
  const updateMutation = useUpdateBillStatementRow()
  const markUniqueMutation = useMarkBillRowUnique()
  const linkDecision = useBillRowLinkDecision()
  /** 这一行有没有和另一笔并成一条。并了就得写在脸上，并给一个拆开的出口。 */
  const pair = pairOf(row)
  const merged = isMergedRow(row)

  /** 拆开：撤回那条配对，两笔各自回到待处理 */
  async function splitPair() {
    if (!pair) return
    try {
      await linkDecision.mutateAsync({ linkId: pair.link_id, action: 'undo' })
      showToast({ kind: 'success', message: copy.PAIR_UNDO_DONE })
    } catch (err) {
      const message = err instanceof AbeiApiError ? err.message : copy.PAIR_SAVE_FAILED
      showToast({ message, kind: 'error', duration: 6000 })
    }
  }

  const [showEvidence, setShowEvidence] = useState(false)
  const [splitOpen, setSplitOpenState] = useState(false)

  function setSplitOpen(open: boolean) {
    setSplitOpenState(open)
    onSplitDialogChange?.(open)
  }
  /** 勾选那一下有没有按住 shift；change 事件读不到修饰键，只能提前记一笔 */
  const shiftHeld = useRef(false)

  /** 「不是重复」：conflict / duplicate 改判成 unique，改完就能正常入账 */
  async function markUnique() {
    try {
      await markUniqueMutation.mutateAsync(row.id)
      showToast({ message: '已标记为「不是重复」', kind: 'success' })
    } catch (err) {
      const message = err instanceof AbeiApiError ? err.message : '改判失败，请重试'
      showToast({ message, kind: 'error', duration: 6000 })
    }
  }

  async function setType(next: 'withdrawal' | 'deposit' | 'transfer', successMessage: string) {
    try {
      await updateMutation.mutateAsync({ rowId: row.id, input: { firefly_type: next } })
      showToast({ message: successMessage, kind: 'success' })
    } catch (err) {
      const message = err instanceof AbeiApiError ? err.message : '保存失败，请重试'
      showToast({ message, kind: 'error', duration: 6000 })
    }
  }

  // 默认底色写实色而不是留透明：行右端那片浮起来的动作要靠 bg-inherit 接住行的底，
  // 底是透明的话，动作和它盖住的账户名会叠在一起。卡片本来就是 surface-1，看不出差别。
  const rowTone = focused
    ? 'bg-[var(--surface-selected)]'
    : selected
      ? 'bg-[var(--brand-soft)]'
      : 'bg-[var(--surface-1)] hover:bg-[var(--surface-hover)]'

  const transactionGroupId = a.transaction_group_id == null ? null : String(a.transaction_group_id)

  /**
   * 行内动作分两档：一个常驻的主动作 + 一个「…」菜单。
   *
   * 主动作按结构化字段选，不按分节名选 —— 分节是叙事，字段才决定这行现在能做什么。
   * 顺序即优先级：卡在哪一步就先给哪一步的出口，都不卡才轮到「编辑」。
   */
  interface RowAction {
    label: string
    onClick?: () => void
    /** 有值表示这个动作是条链接（交易组 id），点了跳交易页 */
    href?: string
    variant?: 'primary' | 'soft' | 'ghost' | 'ghost-danger'
    pending?: boolean
    danger?: boolean
  }

  const actions: RowAction[] = []
  if (mode === 'dismissed') {
    if (onRestore) actions.push({ label: copy.ROW_RESTORE, onClick: onRestore })
  } else if (mode === 'imported') {
    if (transactionGroupId) actions.push({ label: copy.ROW_VIEW_TRANSACTION, href: transactionGroupId })
  } else if (!editing) {
    if (importAttempt?.status === 'uncertain' && onReconcile) {
      actions.push({ label: copy.ROW_RECONCILE, onClick: onReconcile, variant: 'primary' })
    }
    if (importAttempt?.status === 'retryable' && onRetryImport) {
      actions.push({ label: copy.ROW_RETRY_IMPORT, onClick: onRetryImport, variant: 'primary' })
    }
    if (attentionKind === 'pairing_suggested') {
      actions.push({
        label: expanded ? copy.ROW_PAIR_CLOSE : copy.ROW_PAIR_OPEN,
        onClick: onToggleExpand,
        variant: 'primary',
      })
    }
    if (isDuplicateSuspect) {
      actions.push({
        label: copy.ROW_NOT_DUPLICATE,
        onClick: () => void markUnique(),
        variant: 'soft',
        pending: markUniqueMutation.isPending,
      })
    }
    if (a.status === 'needs_split') {
      actions.push({ label: copy.ROW_SPLIT, onClick: () => setSplitOpen(true), variant: 'soft' })
    }
    // 待入账的行字段已经齐了，主动作就是入账；批量按钮在分节头上，这里是单行出口
    if (onImport) actions.push({ label: copy.ROW_IMPORT, onClick: onImport, variant: 'primary' })
    // 合并是系统替用户做的判断，反悔的出口必须一直在，不能只藏在展开层里
    if (merged) {
      actions.push({
        label: copy.MERGED_SPLIT,
        onClick: () => void splitPair(),
        variant: 'ghost',
        pending: linkDecision.isPending,
      })
    }
    actions.push({ label: copy.ROW_EDIT, onClick: onStartEdit, variant: 'ghost' })
    if (onDismiss) {
      actions.push({ label: copy.ROW_DISMISS, onClick: onDismiss, variant: 'ghost-danger', danger: true })
    }
  }

  const primaryAction = actions[0] ?? null
  const menuActions = actions.slice(1)

  return (
    <div
      id={`bill-row-${row.id}`}
      data-focused={focused ? 'true' : undefined}
      className={`group flex flex-col rounded-[4px] transition-colors ${rowTone}`}
    >
      {/*
        行高严格一格。日期不在行上 —— 一封日账单解析出九笔，原来就是把同一个
        「08-08」印九遍，现在搬去了粘性的日期分组头。
        动作按钮浮在行右端盖住账户列（金额要一直看得见），靠 opacity 收起来，不占高度。
      */}
      {/*
        窄屏排不下五列，也没有悬停这回事：换成两行卡片——上行商户和金额，
        下行渠道、时间、状态，动作常驻。宽屏还是原来那一行。
      */}
      <div className="relative flex min-h-[var(--row-h)] flex-wrap items-center gap-x-2 gap-y-1 bg-inherit px-2 py-1.5 text-[12.5px] sm:h-[var(--row-h)] sm:flex-nowrap sm:py-0">
        {selectable ? (
          <input
            type="checkbox"
            aria-label={`选择 ${rowDescription(a)}`}
            checked={selected}
            // 勾选走 onChange，键盘按空格和鼠标点都算数；shift 区间选要读修饰键，
            // 而 change 事件上没有 shiftKey，所以从 mousedown/keydown 里记一笔。
            onChange={() => onSelect?.(shiftHeld.current)}
            onMouseDown={(event) => { shiftHeld.current = event.shiftKey }}
            onKeyDown={(event) => { shiftHeld.current = event.shiftKey }}
            className="shrink-0"
          />
        ) : (
          <span className="w-[13px] shrink-0" aria-hidden />
        )}

        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? '收起详情' : '展开详情'}
          onClick={onToggleExpand}
          className="shrink-0 rounded p-0.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
        >
          <CaretRight aria-hidden className={`size-4 transition-transform ${expanded ? 'rotate-90' : ''}`} />
        </button>

        {/* 平台标顶掉描述里的「支付宝-」前缀：来源交给图形说，文字只留商户名 */}
        <PlatformMark platform={rowPlatform(a)} size={22} />

        {/* 主列要保底宽度：其余列全是固定宽，窄一点的视口下 flex-1 会被挤成 0，整列消失 */}
        {/* 主文案和辅助文案拉开两档：这一格是行的主语，字重要压得住旁边的小字 */}
        <span className="min-w-24 flex-1 truncate font-medium text-[var(--text-primary)]">
          <AiValue ai={ai}>{rowMerchant(a)}</AiValue>
        </span>
        <span className="hidden w-[var(--bill-cat-w)] shrink-0 truncate sm:block">
          {a.category_name ? <CategoryCell label={a.category_name} ai={ai} /> : null}
        </span>
        {/*
          只留资金账户。原来印的是「招行信用卡(5599) → 上海盒马」这种两端都截断的流向：
          右边那截商户名描述里已经有了，左边那截才是这行独有的信息。
          完整流向在展开区里。
        */}
        <span className="hidden w-[var(--bill-account-w)] shrink-0 truncate text-right text-[11.5px] text-[var(--text-secondary)] xl:block">
          {fundingAccount(a)}
        </span>
        <span className={`num w-[var(--bill-amount-w)] shrink-0 text-right ${directionColorClass(a.direction)}`}>
          {directionSign(a.direction)}{currencyPrefix(a)}{formatAmount(rowAmount(a))}
        </span>

        {/*
          动作浮在金额左侧那片区域上（bg 跟着行走，盖住的是账户列）。
          以前它们占着 150px 的常驻宽度，金额就永远和分组头上的当日合计对不齐。
        */}
        {/* 窄屏第二行：渠道、时间、状态。这三样在宽屏是各自成列的，窄屏收成一句。 */}
        <span className="mt-0.5 min-w-0 basis-[55%] grow truncate text-[11px] text-[var(--text-secondary)] sm:hidden">
          {narrowMetaLine(a, badge?.label)}
        </span>

        <span
          className={`ml-auto flex w-auto shrink-0 items-center justify-end gap-1 sm:absolute sm:inset-y-0 sm:right-[var(--bill-action-right)] sm:ml-0 sm:pl-4 ${
            mode === 'attention' ? 'sm:w-[230px]' : 'sm:w-[188px]'
          } ${
            // 动作现在一律常驻，底色也就一律要有：它盖住的是账户列，
            // 透明底会让按钮和账户名叠印在一起。
            'bg-inherit'
          }`}
        >
          {mode === 'dismissed' && (
            <StatusChip label={dismissReasonLabel(a.dismissed_reason)} kind="muted" />
          )}

          {/*
            合并过的行要在行上就认得出来：双渠道标 + 一个「已合并」小签。
            只在展开层里说的话，一屏三十行里哪几行是两笔并出来的完全看不出，
            而合计和笔数都已经按一条算了。
          */}
          {merged && pair && (
            <span className="flex shrink-0 items-center gap-0.5" title={copy.MERGED_CHIP}>
              <ChannelMark channelKey={row.attributes.task?.source ?? ''} />
              <ChannelMark channelKey={pair.other.channel_key ?? ''} />
              <StatusChip label={copy.MERGED_CHIP} kind="muted" />
            </span>
          )}

          {mode !== 'dismissed' && badge && <StatusChip label={badge.label} kind={badge.kind} />}

          {mode === 'attention' && !editing && (
            <>
              {importAttempt?.status === 'uncertain' && <StatusChip label="结果待核实" kind="warn" />}
              {importAttempt?.status === 'retryable' && <StatusChip label="入账失败" kind="warn" />}
              {(importAttempt?.status === 'prepared' || importAttempt?.status === 'sending') && (
                <StatusChip label="正在入账" kind="muted" />
              )}
            </>
          )}

          {/*
            这一行最重要的那个动作常驻。
            原来除了状态签之外全部藏在悬停后面：触屏没有悬停，键盘用户 Tab 过去
            是几个隐形按钮，而鼠标用户得先把指针放上去才知道这行能做什么。
            现在按行的结构化字段选出一个主动作摆出来，其余进「…」。
          */}
          {primaryAction && !editing && (
            primaryAction.href
              ? (
                  <Link
                    to="/transactions"
                    search={txSearch({ transaction: Number(primaryAction.href) })}
                    className="shrink-0 rounded px-1.5 py-1 text-xs font-semibold text-[var(--brand-text)] underline-offset-2 hover:underline"
                  >
                    {primaryAction.label}
                  </Link>
                )
              : (
                  <Button
                    size="xs"
                    variant={primaryAction.variant ?? 'soft'}
                    disabled={busy || primaryAction.pending}
                    onClick={primaryAction.onClick}
                  >
                    {primaryAction.label}
                  </Button>
                )
          )}

          {menuActions.length > 0 && !editing && (
            <Menu>
              <MenuButton as="div">
                <IconButton label={`${rowDescription(a)} 的更多操作`} className="size-6">
                  <DotsThree aria-hidden className="size-4" weight="bold" />
                </IconButton>
              </MenuButton>
              <MenuItems
                anchor="bottom end"
                transition
                className="z-200 mt-1 min-w-48 rounded-md bg-[var(--surface-2)] py-1 shadow-[var(--shadow-pop)] ring-1 ring-[var(--border-subtle)] transition focus:outline-none data-closed:scale-95 data-closed:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in"
              >
                {menuActions.map((action) => (
                  <MenuItem key={action.label} disabled={action.pending}>
                    <button
                      type="button"
                      onClick={action.onClick}
                      className={`${DROPDOWN_ITEM} ${
                        action.danger ? 'text-[var(--danger)] data-focus:bg-[var(--danger-soft)]' : 'text-[var(--text-primary)]'
                      }`}
                    >
                      {action.label}
                    </button>
                  </MenuItem>
                ))}
              </MenuItems>
            </Menu>
          )}
        </span>
      </div>

      {/* 二级：行内编辑 */}
      {editing && (
        <QueueRowEditor row={row} attentionKind={attentionKind} onEndEdit={onEndEdit} />
      )}

      {/* 二级：详情（原始字段 / 判重理由 / AI 建议） → 三级：来源凭证 */}
      {expanded && !editing && (
        <div className="mx-2 mb-2 flex flex-col gap-2 rounded-md bg-[var(--surface-2)] p-3 text-[11.5px] leading-relaxed">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
            <Detail label="原始日期" value={a.occurred_at ?? '--'} mono />
            <Detail label="原始金额" value={`${currencyPrefix(a)}${formatAmount(a.amount ?? '0')}`} mono />
            <Detail label="对手方" value={a.counterparty || '--'} />
            <Detail label="收支方向" value={directionLabel(a.direction)} />
            {/* 「? → 上海盒马」读不出缺的是哪一头，把缺的那一端说出来 */}
            <Detail
              label="账户流向"
              value={`${a.source_name || '付款账户待定'} → ${a.destination_name || '收款账户待定'}`}
            />
            <Detail label="判重" value={duplicateLabel(a.duplicate_state, a.duplicate_of_row_id)} />
            {a.category_name ? <Detail label="分类" value={a.category_name} /> : null}
            {a.notes ? <Detail label="备注" value={a.notes} /> : null}
            {mode === 'dismissed' ? <Detail label="忽略原因" value={dismissReasonLabel(a.dismissed_reason)} /> : null}
            {/*
              后端给的 error_message 是英文技术原文。正文说人话，原文降为小字：
              直接把「Failed to resolve account」印在「出错原因」后面，等于没说。
            */}
            {a.error_message ? <Detail label="出错原因" value={copy.ROW_DETAIL_ERROR} note={a.error_message} /> : null}
            {importAttempt?.status ? <ImportStatusDetail status={importAttempt.status} /> : null}
            {importAttempt?.error_message
              ? <Detail label="入账出错" value={copy.ROW_DETAIL_IMPORT_ERROR} note={importAttempt.error_message} />
              : null}
            {importAttempt?.retry_after ? <Detail label="最早可重试" value={importAttempt.retry_after} mono /> : null}
          </dl>

          {reasons.length > 0 && (
            <div className="flex flex-wrap items-start gap-1.5">
              <span className="text-[var(--text-secondary)]">待确认的原因</span>
              {reasons.map((reason) => (
                <StatusChip key={reason} label={reason} kind="warn" />
              ))}
            </div>
          )}

          {/*
            窄屏上右侧那格的动作按钮挤不下，展开区再放一份全称的。
            这里的措辞比行内那几个短标签完整，确认前该看清做的是什么。
          */}
          {mode === 'attention' && (
            <div className="flex flex-wrap items-center gap-1.5">
              {/* 展开区里的按钮把后果写全，不留实现名词（external_id / Firefly 发送） */}
              {importAttempt?.status === 'uncertain' && onReconcile && (
                <Button size="xs" variant="soft" disabled={busy} onClick={onReconcile}>
                  按凭证号核实账本里有没有这笔
                </Button>
              )}
              {importAttempt?.status === 'retryable' && onRetryImport && (
                <Button size="xs" variant="soft" disabled={busy} onClick={onRetryImport}>
                  重试入账，成功即进已入账
                </Button>
              )}
              {a.firefly_type === 'transfer' && (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={updateMutation.isPending}
                  onClick={() => void setType(
                    directionLabel(a.direction) === '收入' ? 'deposit' : 'withdrawal',
                    '已改成普通收支',
                  )}
                >
                  不是转账，按普通收支记
                </Button>
              )}
              {/* 判重那两颗按钮不在这里：它们跟着下面的并排对比走，看完再点 */}
              {a.status === 'needs_split' && (
                <Button size="xs" variant="soft" onClick={() => setSplitOpen(true)}>
                  拆成多笔再入账
                </Button>
              )}
            </div>
          )}

          {ai && (
            <p className="text-[var(--text-secondary)]">
              带底色的值为 AI 建议，入账即视为确认；修改后恢复普通样式。
            </p>
          )}

          {/*
            疑似重复不能只写一句「和已有交易很像」——像在哪儿一个字都没说，
            用户没有依据能判断。把账本里那一笔并排摆出来，两个按钮说清后果。
          */}
          {isDuplicateSuspect && (
            <section className="flex flex-col gap-2 rounded-md bg-[var(--surface-1)] p-2.5">
              <h4 className="text-[12px] font-semibold text-[var(--text-primary)]">{copy.DUP_COMPARE_TITLE}</h4>
              {a.duplicate_of ? (
                <CompareTable
                  leftLabel={copy.DUP_THIS_LABEL}
                  rightLabel={copy.DUP_OTHER_LABEL}
                  mergeSame={false}
                  fields={duplicateFields(row)}
                />
              ) : (
                <p className="text-[11px] text-[var(--text-tertiary)]">{copy.DUP_MISSING}</p>
              )}
              <div className="flex flex-wrap items-center gap-1.5">
                {onDismiss && (
                  <Button size="xs" variant="soft" disabled={busy} onClick={onDismiss}>
                    {copy.DUP_IGNORE}
                  </Button>
                )}
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={markUniqueMutation.isPending}
                  onClick={() => void markUnique()}
                >
                  {copy.DUP_NOT_DUPLICATE}
                </Button>
              </div>
            </section>
          )}

          {/*
            配对：服务端把对侧随行下发之后就地渲染；老响应没有 pair 字段时
            退回单发一趟 /links 的老面板，不然这一段会整块消失。
          */}
          {pair ? <RowPairPanel row={row} /> : <PairingSuggestions rowId={row.id} />}

          <RowTimeline row={row} />

          {/* 入账是发到 Firefly 的，阿贝这边撤不回来，明说比让人找一圈撤销按钮强。 */}
          {mode === 'imported' && (
            <p className="text-[var(--text-secondary)]">
              这笔已经进 Firefly 了。要改或要删，去交易页面上改，收件箱这里不会再动它。
            </p>
          )}

          <div>
            <button
              type="button"
              aria-expanded={showEvidence}
              onClick={() => setShowEvidence((value) => !value)}
              className="text-[var(--brand-text)] underline-offset-2 hover:underline"
            >
              {showEvidence ? '收起来源凭证' : '来源凭证（邮件、事件、产物）'}
            </button>
          </div>

          {showEvidence && (
            a.task
              ? <TaskEvidencePanel task={a.task} />
              : (
                  <p className="text-[var(--text-secondary)]">
                    这条流水没带来源邮件信息{a.bill_task_id ? `（邮件 #${String(a.bill_task_id)}）` : ''}。
                  </p>
                )
          )}
        </div>
      )}

      <SplitBillRowDialog row={row} open={splitOpen} onClose={() => setSplitOpen(false)} />
    </div>
  )
}

function Detail({
  label,
  value,
  note,
  mono = false,
}: {
  label: string
  value: string
  /** 技术原文（错误码、后端英文 message）。永远只当小字，不进正文。 */
  note?: string | null
  mono?: boolean
}) {
  return (
    <div className="flex gap-2">
      <dt className="w-[64px] shrink-0 text-[var(--text-secondary)]">{label}</dt>
      <dd className="min-w-0 flex-1">
        <span className={`block break-words text-[var(--text-primary)] ${mono ? 'num' : ''}`}>{value}</span>
        {note && <span className="block break-words text-[10.5px] text-[var(--text-tertiary)]">{note}</span>}
      </dd>
    </div>
  )
}

/** 入账状态。认不出的状态码不直出，兜底一句人话 + 原码小字。 */
function ImportStatusDetail({ status }: { status: string }) {
  const { text, detail } = copy.importAttemptStatusText(status)
  return <Detail label="入账状态" value={text} note={detail} />
}

/** 行上的小号渠道标。合并过的行要一眼看出是哪两个渠道并出来的。 */
function ChannelMark({ channelKey }: { channelKey: string }) {
  const platform = (channelKey in BRAND_MARKS ? channelKey : 'other') as PlatformKey
  return <PlatformMark platform={platform} size={16} title={channelDisplayName(channelKey)} />
}

/** 判重并排对比的四项：日期、金额、描述、账户 */
function duplicateFields(row: BillQueueRow): CompareField[] {
  const a = row.attributes
  const other = a.duplicate_of ?? {}
  const otherAmount = Math.abs(Number(other.signed_amount ?? '0') || 0)
  return [
    { label: copy.FIELD_DATE, left: rowDate(a) ?? '', right: (other.occurred_at ?? '').slice(0, 10) },
    {
      label: copy.FIELD_AMOUNT,
      left: `${currencyPrefix(a)}${formatAmount(rowAmount(a))}`,
      right: `${currencyPrefixOf(other.currency_code)}${formatAmount(String(otherAmount))}`,
    },
    { label: copy.FIELD_DESCRIPTION, left: rowDescription(a), right: other.description ?? '' },
    { label: copy.FIELD_ACCOUNT, left: fundingAccount(a), right: other.source_name ?? other.destination_name ?? '' },
  ]
}

function duplicateLabel(state: string, ofRowId: string | number | null | undefined): string {
  const suffix = ofRowId ? `（对应流水 #${String(ofRowId)}）` : ''
  if (state === 'duplicate') return `系统判定重复${suffix}`
  if (state === 'conflict') return `和账本里已有的交易对不上${suffix}`
  return '没有发现重复'
}
