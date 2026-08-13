import { useState, type ReactNode } from 'react'
import { CaretRight } from '@phosphor-icons/react'
import { Link } from '@tanstack/react-router'
import type { BillQueueRow } from '../../api/schemas'
import { useCategoryFeedback, useMarkBillRowUnique, useUpdateBillStatementRow } from '../../api/queries'
import { CategoryPicker, DOMAINS_BY_TX_TYPE, type CategoryDomain } from '../../components/abei/CategoryPicker'
import { StatusChip } from '../../components/abei/StatusChip'
import { showToast } from '../../store/toastStore'
import { formatAmount } from '../../lib/format'
import { AbeiApiError } from '../../api/client'
import {
  directionColorClass,
  directionSign,
  dismissReasonLabel,
  fundingAccount,
  isAiSuggested,
  rowAmount,
  rowBadge,
  rowDate,
  rowDescription,
  rowMerchant,
  rowPlatform,
  type AttentionKind,
  type InboxView,
} from './billInboxHelpers'
import { PlatformMark } from './PlatformMark'
import { SplitBillRowDialog } from './SplitBillRowDialog'
import { TaskEvidencePanel } from './TaskEvidencePanel'
import { isPositiveDecimal, normalizeDecimalString } from '../../lib/decimal'
import { Button } from '../../components/ui/Button'
import { txSearch } from '../../routes/transactionSearch'

/**
 * 行内编辑控件。`Field` 那套是竖排 label + 控件，这里格子小、字段多，
 * label 只能走 aria-label，所以复用 Field 的 outline 写法把尺寸压下来。
 */
const CELL =
  'rounded px-1.5 py-1 text-xs bg-[var(--surface-2)] text-[var(--text-primary)] '
  + 'outline-1 -outline-offset-1 outline-[var(--border-strong)] placeholder:text-[var(--text-tertiary)] '
  + 'focus:outline-2 focus:-outline-offset-2 focus:outline-[var(--focus-ring)]'

function asText(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** 收支流水默认只让挑收入 / 支出域；识别成转账的行才放开资金往来 */
function domainsFor(fireflyType: string): CategoryDomain[] {
  if (fireflyType === 'withdrawal' || fireflyType === 'deposit' || fireflyType === 'transfer') {
    return DOMAINS_BY_TX_TYPE[fireflyType]
  }
  return ['income', 'expense']
}

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
  onMapAccount,
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
  onMapAccount?: () => void
  busy?: boolean
}) {
  const a = row.attributes
  const effectiveDate = rowDate(a)
  const badge = rowBadge(row)
  const ai = isAiSuggested(row)
  /** 立规则用的模式：优先对手方，退回商家 / 来源账户 */
  const counterparty = (asText(a.counterparty) || asText(a.destination_name) || asText(a.source_name)).trim()
  const reasons = a.reasons ?? []
  const importAttempt = a.import_attempt
  const needsAccountMapping = a.issues?.some((issue) => issue.code === 'account_mapping_required') ?? false
  const updateMutation = useUpdateBillStatementRow()
  const markUniqueMutation = useMarkBillRowUnique()
  const categoryFeedback = useCategoryFeedback()

  const [showEvidence, setShowEvidence] = useState(false)
  const [splitOpen, setSplitOpen] = useState(false)

  const [desc, setDesc] = useState('')
  const [category, setCategory] = useState('')
  /** 进编辑时的分类，用来判断人是不是把 AI 建议的那个改掉了 */
  const [categoryAtOpen, setCategoryAtOpen] = useState('')
  const [makeRule, setMakeRule] = useState(false)
  const [amount, setAmount] = useState('')
  const [transactionType, setTransactionType] = useState('')
  const [date, setDate] = useState('')
  const [source, setSource] = useState('')
  const [destination, setDestination] = useState('')
  const [notes, setNotes] = useState('')

  function startEdit() {
    const d = rowDescription(a)
    setDesc(d === '--' ? '' : d)
    setCategory(asText(a.category_name))
    setCategoryAtOpen(asText(a.category_name))
    setMakeRule(false)
    setAmount(rowAmount(a))
    setTransactionType(a.firefly_type ?? '')
    setDate(effectiveDate?.slice(0, 10) ?? '')
    setSource(asText(a.source_name))
    setDestination(asText(a.destination_name))
    setNotes(asText(a.notes))
    onStartEdit()
  }

  async function saveEdit() {
    const descTrim = desc.trim()
    const sourceTrim = source.trim()
    const destinationTrim = destination.trim()
    if (!transactionType || !date || !descTrim || !sourceTrim || !destinationTrim) {
      showToast({ message: '请补全类型、日期、描述和账户流向', kind: 'error' })
      return
    }
    let amountStr: string
    try {
      if (!amount.trim() || !isPositiveDecimal(amount)) throw new Error('invalid amount')
      amountStr = normalizeDecimalString(amount)
    } catch {
      showToast({ message: '请输入大于 0 的金额', kind: 'error' })
      return
    }
    try {
      // 只写「要记成什么」，不碰银行原文（amount / description / occurred_at / counterparty）：
      // 那几个字段 rows.update 根本不收，原文得留着当对账依据。
      await updateMutation.mutateAsync({
        rowId: row.id,
        input: {
          firefly_type: transactionType as 'withdrawal' | 'deposit' | 'transfer',
          firefly_date: date,
          firefly_description: descTrim,
          source_name: sourceTrim,
          destination_name: destinationTrim,
          category_name: category.trim() || null,
          notes: notes.trim() || null,
          firefly_amount: amountStr,
        },
      })
      // 反馈是「顺手学一条规则」，失败不该让人以为这一笔没存上，所以单独 catch
      if (makeRule && category.trim() && counterparty) {
        try {
          await categoryFeedback.mutateAsync({
            pattern: counterparty,
            category_name: category.trim(),
            make_rule: true,
          })
        } catch {
          showToast({ message: '已保存，但规则创建失败', kind: 'error', duration: 6000 })
        }
      }
      onEndEdit()
      showToast({ message: '已保存', kind: 'success' })
    } catch (err) {
      const message = err instanceof AbeiApiError ? err.message : '保存失败，请重试'
      showToast({ message, kind: 'error', duration: 6000 })
    }
  }

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

  // 这一格里有没有不靠悬停就该看见的东西（状态签 / 恢复 / 查看交易）。
  const alwaysVisible =
    mode === 'dismissed'
    || mode === 'imported'
    || (badge != null && !editing)
    || (mode === 'attention' && (importAttempt != null || needsAccountMapping))

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
      <div className="relative flex h-[var(--row-h)] items-center gap-2 bg-inherit px-2 text-[12.5px]">
        {selectable ? (
          <input
            type="checkbox"
            aria-label={`选择 ${rowDescription(a)}`}
            checked={selected}
            onChange={() => undefined}
            onClick={(event) => onSelect?.(event.shiftKey)}
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
        <span className="min-w-24 flex-1 truncate text-[var(--text-primary)]">
          <AiValue ai={ai}>{rowMerchant(a)}</AiValue>
        </span>
        <span className="hidden w-[104px] shrink-0 truncate sm:block">
          {a.category_name ? <CategoryCell label={a.category_name} ai={ai} /> : null}
        </span>
        {/*
          只留资金账户。原来印的是「招行信用卡(5599) → 上海盒马」这种两端都截断的流向：
          右边那截商户名描述里已经有了，左边那截才是这行独有的信息。
          完整流向在展开区里。
        */}
        <span className="hidden w-[132px] shrink-0 truncate text-right text-[11.5px] text-[var(--text-secondary)] xl:block">
          {fundingAccount(a)}
        </span>
        <span className={`num w-[104px] shrink-0 text-right ${directionColorClass(a.direction)}`}>
          {directionSign(a.direction)}{a.currency_symbol ?? a.currency_code ?? ''}{formatAmount(rowAmount(a))}
        </span>

        {/*
          动作浮在金额左侧那片区域上（bg 跟着行走，盖住的是账户列）。
          以前它们占着 150px 的常驻宽度，金额就永远和分组头上的当日合计对不齐。
        */}
        <span
          className={`absolute inset-y-0 right-[112px] flex shrink-0 items-center justify-end gap-1 pl-4 ${
            mode === 'attention' ? 'w-[196px]' : 'w-[150px]'
          } ${
            // 常驻内容（状态签、恢复/查看交易）得有底色盖住账户列；纯悬停动作的行不能常驻底色，
            // 否则整列账户名被一片同色挡住，看着像根本没渲染。
            alwaysVisible
              ? 'bg-inherit'
              : 'bg-transparent group-hover:bg-inherit focus-within:bg-inherit'
          }`}
        >
          {mode === 'dismissed' && (
            <>
              <StatusChip label={dismissReasonLabel(a.dismissed_reason)} kind="muted" />
              {onRestore && (
                <Button size="xs" variant="soft" disabled={busy} onClick={onRestore}>
                  恢复
                </Button>
              )}
            </>
          )}

          {mode === 'imported' && (
            <>
              {badge && <StatusChip label={badge.label} kind={badge.kind} />}
              {transactionGroupId && (
                <Link
                  to="/transactions"
                  search={txSearch({ transaction: Number(transactionGroupId) })}
                  className="rounded px-1.5 py-1 text-xs font-semibold text-[var(--brand-text)] underline-offset-2 hover:underline"
                >
                  查看交易
                </Link>
              )}
            </>
          )}

          {(mode === 'importable' || mode === 'attention') && !editing && (
            <>
              {badge && <StatusChip label={badge.label} kind={badge.kind} />}
              {mode === 'attention' && importAttempt?.status === 'uncertain' && (
                <>
                  <StatusChip label="结果待对账" kind="warn" />
                  {onReconcile && (
                    <Button size="xs" variant="soft" disabled={busy} onClick={onReconcile}>
                      对账
                    </Button>
                  )}
                </>
              )}
              {mode === 'attention' && importAttempt?.status === 'retryable' && (
                <>
                  <StatusChip label="可以重试" kind="warn" />
                  {onRetryImport && (
                    <Button size="xs" variant="soft" disabled={busy} onClick={onRetryImport}>
                      重试
                    </Button>
                  )}
                </>
              )}
              {mode === 'attention' && (importAttempt?.status === 'prepared' || importAttempt?.status === 'sending') && (
                <StatusChip label="正在入账" kind="muted" />
              )}
              {mode === 'attention' && needsAccountMapping && onMapAccount && (
                <Button size="xs" variant="soft" disabled={busy} onClick={onMapAccount}>
                  映射账户
                </Button>
              )}
              {/*
                悬停才显形，但键盘聚焦时必须现出来，否则 Tab 过去是几个隐形按钮。
                用 opacity 而不是 hidden，正是为了让它们始终可聚焦。
              */}
              <span className="pointer-events-none flex items-center gap-1 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
                {mode === 'attention' && attentionKind === 'transfer' && (
                  <Button
                    size="xs"
                    variant="soft"
                    disabled={updateMutation.isPending}
                    onClick={() => void setType('transfer', '已确认为转账')}
                  >
                    确认转账
                  </Button>
                )}
                {mode === 'attention' && (attentionKind === 'duplicate' || attentionKind === 'conflict') && (
                  <Button size="xs" variant="soft" disabled={updateMutation.isPending} onClick={() => void markUnique()}>
                    不是重复
                  </Button>
                )}
                {mode === 'attention' && attentionKind === 'split' && (
                  <Button size="xs" variant="soft" onClick={() => setSplitOpen(true)}>
                    拆分
                  </Button>
                )}
                <Button size="xs" variant="ghost" onClick={startEdit}>
                  {attentionKind === 'note' ? '补备注' : '编辑'}
                </Button>
                {onDismiss && (
                  <Button size="xs" variant="ghost-danger" disabled={busy} onClick={onDismiss}>
                    忽略
                  </Button>
                )}
              </span>
            </>
          )}
        </span>
      </div>

      {/* 二级：行内编辑 */}
      {editing && (
        <div
          className="mx-2 mb-2 grid grid-cols-2 gap-2 rounded-md bg-[var(--surface-2)] p-2 sm:grid-cols-4"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              onEndEdit()
            }
            if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) {
              event.preventDefault()
              void saveEdit()
            }
          }}
        >
          <select
            value={transactionType}
            onChange={(e) => setTransactionType(e.target.value)}
            aria-label="交易类型"
            className={CELL}
          >
            <option value="">类型</option>
            <option value="withdrawal">支出</option>
            <option value="deposit">收入</option>
            <option value="transfer">转账</option>
          </select>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="交易日期" className={CELL} />
          <input value={desc} onChange={(e) => setDesc(e.target.value)} aria-label="描述" placeholder="描述" className={`${CELL} col-span-2`} />
          <CategoryPicker
            value={category || null}
            onChange={(name) => setCategory(name ?? '')}
            domains={domainsFor(transactionType)}
            aria-label="分类"
            placeholder="分类"
          />
          <input value={source} onChange={(e) => setSource(e.target.value)} aria-label="来源账户" placeholder="来源账户" className={CELL} />
          <input value={destination} onChange={(e) => setDestination(e.target.value)} aria-label="目标账户" placeholder="目标账户" className={CELL} />
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
            aria-label="金额"
            inputMode="decimal"
            className={`${CELL} num text-right`}
          />
          {/* AI 建议的分类被人改掉了：顺手问一句要不要立成规则，以后同一个对手方自动归这儿 */}
          {ai && counterparty !== '' && category.trim() !== '' && category.trim() !== categoryAtOpen.trim() && (
            <label className="col-span-2 flex items-center gap-2 text-[11.5px] text-[var(--text-secondary)] sm:col-span-4">
              <input
                type="checkbox"
                checked={makeRule}
                onChange={(e) => setMakeRule(e.target.checked)}
                className="size-4 accent-[var(--brand)]"
              />
              以后「{counterparty}」都归「{category.trim()}」
            </label>
          )}
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            aria-label="备注"
            placeholder="备注"
            autoFocus={attentionKind === 'note'}
            className={`${CELL} col-span-2 sm:col-span-3`}
          />
          <div className="col-span-2 flex items-center justify-end gap-1.5 sm:col-span-1">
            <Button size="xs" variant="ghost" disabled={updateMutation.isPending} onClick={onEndEdit}>
              取消
            </Button>
            <Button size="xs" variant="primary" disabled={updateMutation.isPending} onClick={() => void saveEdit()}>
              {updateMutation.isPending ? '保存中…' : '保存'}
            </Button>
          </div>
        </div>
      )}

      {/* 二级：详情（原始字段 / 判重理由 / AI 建议） → 三级：来源凭证 */}
      {expanded && !editing && (
        <div className="mx-2 mb-2 flex flex-col gap-2 rounded-md bg-[var(--surface-2)] p-3 text-[11.5px] leading-relaxed">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
            <Detail label="原始日期" value={a.occurred_at ?? '--'} mono />
            <Detail label="原始金额" value={`${a.currency_symbol ?? a.currency_code ?? ''}${formatAmount(a.amount ?? '0')}`} mono />
            <Detail label="对手方" value={a.counterparty || '--'} />
            <Detail label="收支方向" value={a.direction || '--'} />
            <Detail label="账户流向" value={`${a.source_name ?? '?'} → ${a.destination_name ?? '?'}`} />
            <Detail label="判重" value={duplicateLabel(a.duplicate_state, a.duplicate_of_row_id)} />
            {a.category_name ? <Detail label="分类" value={a.category_name} /> : null}
            {a.notes ? <Detail label="备注" value={a.notes} /> : null}
            {mode === 'dismissed' ? <Detail label="忽略原因" value={dismissReasonLabel(a.dismissed_reason)} /> : null}
            {a.error_message ? <Detail label="出错信息" value={a.error_message} /> : null}
            {importAttempt?.status ? <Detail label="导入状态" value={importAttemptStatusLabel(importAttempt.status)} /> : null}
            {importAttempt?.error_message ? <Detail label="导入错误" value={importAttempt.error_message} /> : null}
            {importAttempt?.retry_after ? <Detail label="可重试时间" value={importAttempt.retry_after} mono /> : null}
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
              {importAttempt?.status === 'uncertain' && onReconcile && (
                <Button size="xs" variant="soft" disabled={busy} onClick={onReconcile}>
                  按 external_id 对账
                </Button>
              )}
              {importAttempt?.status === 'retryable' && onRetryImport && (
                <Button size="xs" variant="soft" disabled={busy} onClick={onRetryImport}>
                  重新发送到 Firefly
                </Button>
              )}
              {needsAccountMapping && onMapAccount && (
                <Button size="xs" variant="soft" disabled={busy} onClick={onMapAccount}>
                  选择 Firefly 账户
                </Button>
              )}
              {attentionKind === 'transfer' && (
                <>
                  <Button
                    size="xs"
                    variant="soft"
                    disabled={updateMutation.isPending}
                    onClick={() => void setType('transfer', '已确认为转账')}
                  >
                    {a.destination_name ? `确认转账到 ${a.destination_name}` : '确认是转账'}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={updateMutation.isPending}
                    onClick={() => void setType(a.direction === '收入' ? 'deposit' : 'withdrawal', '已改回普通收支')}
                  >
                    不是转账
                  </Button>
                </>
              )}
              {(attentionKind === 'duplicate' || attentionKind === 'conflict') && (
                <Button size="xs" variant="soft" disabled={updateMutation.isPending} onClick={() => void markUnique()}>
                  不是重复
                </Button>
              )}
              {attentionKind === 'split' && (
                <Button size="xs" variant="soft" onClick={() => setSplitOpen(true)}>
                  拆分这笔
                </Button>
              )}
            </div>
          )}

          {ai && (
            <p className="text-[var(--text-secondary)]">
              带底色的值为 AI 建议，入账即视为确认；修改后恢复普通样式。
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

function Detail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="w-[64px] shrink-0 text-[var(--text-secondary)]">{label}</dt>
      <dd className={`min-w-0 flex-1 break-words text-[var(--text-primary)] ${mono ? 'num' : ''}`}>{value}</dd>
    </div>
  )
}

function duplicateLabel(state: string, ofRowId: string | number | null | undefined): string {
  const suffix = ofRowId ? `（对应流水 #${String(ofRowId)}）` : ''
  if (state === 'duplicate') return `机器判定重复${suffix}`
  if (state === 'conflict') return `与已有交易冲突${suffix}`
  return '没有重复'
}

function importAttemptStatusLabel(status: string): string {
  if (status === 'prepared') return '已准备，等待发送'
  if (status === 'sending') return '正在发送'
  if (status === 'uncertain') return '结果不确定，需要对账'
  if (status === 'retryable') return '发送失败，可以重试'
  if (status === 'rejected') return 'Firefly 已拒绝'
  if (status === 'reconciled') return '已对账'
  if (status === 'succeeded') return '已成功'
  return status
}
