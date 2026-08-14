import { useState } from 'react'
import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react'
import { ArrowsClockwise, DotsThree, Prohibit } from '@phosphor-icons/react'
import type { BillTask } from '../../api/schemas'
import {
  useArchiveBillTask,
  useRetryBillTask,
  useSubmitBillTaskSecret,
} from '../../api/queries'
import { AbeiApiError } from '../../api/client'
import { dryRunPreviewSchema } from '../../api/gate'
import { showToast } from '../../store/toastStore'
import { Button, IconButton } from '../../components/ui/Button'
import { DROPDOWN_ITEM } from '../../components/ui/Dropdown'
import { Field, Input } from '../../components/ui/Field'
import { Modal } from '../../components/abei/Modal'
import { StatusChip } from '../../components/abei/StatusChip'
import { Skeleton } from '../../components/abei/Skeleton'
import { InlineError } from '../../components/abei/ErrorState'
import { LottieIcon } from '../../components/abei/LottieIcon'
import { formatMonthDay } from '../../lib/format'
import { PlatformMark } from './PlatformMark'
import type { PlatformKey } from './brandMarks'
import { mailStateBadge, mailSubject } from './billInboxHelpers'

export interface SourceGroup {
  key: string
  label: string
  platform: PlatformKey
  tasks: BillTask[]
}

/**
 * 顶部渠道条（来源面板的第三态，定稿用的就是它）。
 *
 * 原来这是左边一整栏，占掉 248px，主区被挤到看不下几列；而它一天里真正被用到的
 * 只有「换个来源看看」和「这封邮件要解锁」两件事。于是整栏收成一排 chip 钉在顶上，
 * 主区拿到全宽；选中某个渠道才展开它名下的邮件，选中的那封要是卡住了，
 * 解锁 / 重新解析就在下面那条里做完。
 */
export function ChannelBar({
  groups,
  counts,
  totalCount,
  loading,
  error,
  onRetryLoad,
  selectedSource,
  onSelectSource,
  selectedTaskId,
  onSelectTask,
}: {
  groups: SourceGroup[]
  /** 渠道 key → 当前 tab 下这个渠道有多少笔 */
  counts: Record<string, number | undefined>
  totalCount: number
  loading: boolean
  /** 传错误对象本身，不是布尔：InlineError 要靠它按 reason 分情形说话。 */
  error: unknown
  onRetryLoad: () => void
  /** null = 全部渠道 */
  selectedSource: string | null
  onSelectSource: (source: string | null) => void
  /** null = 不钉在某一封邮件上 */
  selectedTaskId: string | null
  onSelectTask: (taskId: string | null) => void
}) {
  const selectedGroup = groups.find((group) => group.key === selectedSource) ?? null
  const mails = selectedGroup?.tasks ?? []
  const selectedTask = groups.flatMap((group) => group.tasks).find((task) => task.id === selectedTaskId) ?? null

  return (
    <nav aria-label="来源渠道" className="flex flex-col gap-2">
      {/* 窄屏渠道多起来会换两三行，把顶部条撑得很高，改成横向滚动 */}
      <div className="flex items-center gap-1.5 overflow-x-auto sm:flex-wrap sm:overflow-x-visible">
        <ChannelChip
          label="全部来源"
          count={totalCount}
          selected={selectedSource === null && selectedTaskId === null}
          onClick={() => onSelectSource(null)}
        />
        {groups.map((group) => (
          <ChannelChip
            key={group.key}
            label={group.label}
            platform={group.platform}
            count={counts[group.key]}
            selected={selectedSource === group.key}
            onClick={() => onSelectSource(selectedSource === group.key ? null : group.key)}
          />
        ))}
        {Boolean(error) && <InlineError message="来源邮件加载失败" error={error} onRetry={onRetryLoad} />}
        {loading && groups.length === 0 && <Skeleton className="h-7 w-40" />}
        {!loading && !error && groups.length === 0 && (
          <span className="text-[11.5px] text-[var(--text-secondary)]">
            没有解析中的账单邮件，可在右上角同步邮件。
          </span>
        )}
      </div>

      {/* 选中渠道才展开它名下的邮件：不选的时候这一排是纯噪音 */}
      {selectedGroup && mails.length > 0 && (
        <div className="flex items-start gap-1.5">
          <span className="shrink-0 pt-1 text-[11px] text-[var(--text-tertiary)]">邮件</span>
          {/* 一个渠道可能囤了几十封，限高滚动，别把置顶条撑成半屏 */}
          <div className="flex max-h-[64px] flex-wrap items-center gap-1.5 overflow-y-auto pr-1">
            {mails.map((task) => (
              <MailChip
                key={task.id}
                task={task}
                channelLabel={selectedGroup.label}
                selected={selectedTaskId === task.id}
                onSelect={() => onSelectTask(selectedTaskId === task.id ? null : task.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* 选中的这封要人动手（等密码 / 解析崩了）才出这条，平时不占地方 */}
      {selectedTask && <MailActions task={selectedTask} />}
    </nav>
  )
}

function ChannelChip({
  label,
  platform,
  count,
  selected,
  onClick,
}: {
  label: string
  platform?: PlatformKey
  count?: number
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[12.5px] transition-colors ${
        selected
          ? 'border-[var(--brand)] bg-[var(--brand-soft)] font-semibold text-[var(--brand-text)]'
          : 'border-[var(--border-subtle)] bg-[var(--surface-1)] text-[var(--text-primary)] hover:bg-[var(--surface-hover)]'
      }`}
    >
      {platform && <PlatformMark platform={platform} size={18} title="" />}
      {label}
      {count !== undefined && <span className="num text-[11px] text-[var(--text-secondary)]">{count}</span>}
    </button>
  )
}

function MailChip({
  task,
  channelLabel,
  selected,
  onSelect,
}: {
  task: BillTask
  channelLabel: string
  selected: boolean
  onSelect: () => void
}) {
  const badge = mailStateBadge(task)
  const attrs = task.attributes
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`flex h-7 max-w-[320px] items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] transition-colors ${
        selected
          ? 'border-[var(--brand)] bg-[var(--brand-soft)] text-[var(--brand-text)]'
          : 'border-[var(--border-subtle)] bg-[var(--surface-1)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]'
      }`}
    >
      <span className="num shrink-0">{attrs.received_at ? formatMonthDay(attrs.received_at) : '--'}</span>
      <span className="truncate">{mailSubject(task, channelLabel)}</span>
      <StatusChip label={badge.label} kind={badge.kind} />
    </button>
  )
}

/**
 * 选中那封邮件的操作条：解锁、重新解析、忽略这封。
 *
 * 原来这些按钮挂在左栏每一行邮件上，十一封邮件就是十一组按钮；现在只给
 * 当下选中的那一封出一条，卡住的（待解锁 / 解析失败）默认把话说完，
 * 正常的那几封只留一个「…」菜单。
 */
function MailActions({ task }: { task: BillTask }) {
  const attrs = task.attributes
  const needsSecret = attrs.status === 'needs_secret'
  const failed = attrs.status === 'failed' || attrs.status === 'unknown'

  const [secretValue, setSecretValue] = useState('')
  const [ignoreOpen, setIgnoreOpen] = useState(false)
  /**
   * 解锁的干跑结果。非空表示「已经问过服务端了，等人点确认」。
   *
   * 密码本身不进这里，也不进任何缓存——干跑那一趟服务端根本没把它递给上游，
   * 确认那一趟用的还是输入框里人当场敲的那份值。
   */
  const [unlockPreview, setUnlockPreview] = useState<string | null>(null)

  const secretMutation = useSubmitBillTaskSecret()
  const retryMutation = useRetryBillTask()
  // 「忽略这封邮件」= 后端的 archive：邮件移出收件箱，名下没处置的流水一并忽略。
  // ignore 只把邮件标掉、把流水留在队列里成孤儿，不是这里要的语义。
  const archiveMutation = useArchiveBillTask()

  const errorText = attrs.error_message || attrs.error_code || null
  // 密码错了后端退回 needs_secret，把原因留在输入框旁：光靠 toast 不够，
  // 它几秒就没了，刷新一下就再也看不出自己错在哪。
  const secretError = attrs.error_code === 'secret_rejected' ? errorText : null

  /**
   * 第一步：干跑。`bills.unlock` 是 confirm 档，不先问一句服务端就是 409。
   * 干跑只回一句「会发生什么」，密码不出阿贝。
   */
  async function previewUnlock() {
    const value = secretValue.trim()
    if (!value) {
      showToast({ message: '请输入密码或验证码', kind: 'error' })
      return
    }
    try {
      const preview = await secretMutation.mutateAsync({ taskId: task.id, value, confirm: false })
      const parsed = dryRunPreviewSchema.safeParse(preview)
      setUnlockPreview(
        (parsed.success && parsed.data.message)
        || '会把密码提交给这份账单，然后重新解析。',
      )
    } catch (err) {
      showToast({
        message: err instanceof AbeiApiError ? err.message : '解锁失败，请重试',
        kind: 'error',
        duration: 6000,
      })
    }
  }

  /** 第二步：人点了确认，带上 confirm=true 真提交。密码仍取输入框里的当前值。 */
  async function confirmUnlock() {
    const value = secretValue.trim()
    if (!value) return
    try {
      await secretMutation.mutateAsync({ taskId: task.id, value, confirm: true })
      setUnlockPreview(null)
      setSecretValue('')
      showToast({ message: '已解锁，正在解析这封邮件', kind: 'success' })
    } catch (err) {
      showToast({
        message: err instanceof AbeiApiError ? err.message : '解锁失败，请重试',
        kind: 'error',
        duration: 6000,
      })
    }
  }

  async function retry() {
    try {
      await retryMutation.mutateAsync(task.id)
      showToast({ message: '已排队重新解析', kind: 'success' })
    } catch (err) {
      showToast({
        message: err instanceof AbeiApiError ? err.message : '重新解析失败，请重试',
        kind: 'error',
        duration: 6000,
      })
    }
  }

  async function ignoreMail() {
    try {
      await archiveMutation.mutateAsync(task.id)
      setIgnoreOpen(false)
      showToast({ message: '已忽略这封邮件', kind: 'success' })
    } catch (err) {
      showToast({
        message: err instanceof AbeiApiError ? err.message : '忽略失败，请重试',
        kind: 'error',
        duration: 6000,
      })
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md bg-[var(--surface-2)] px-2.5 py-2">
      {needsSecret && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void previewUnlock()
          }}
        >
          {/* 用真 label 而不是 placeholder：placeholder 一输入就消失，
              用户回头看不出这格填的是什么 */}
          <Field label="解压密码" hint="提交后重新解析附件" error={secretError ?? undefined}>
            <Input
              type="password"
              autoComplete="off"
              value={secretValue}
              onChange={(event) => setSecretValue(event.target.value)}
            />
          </Field>
          <Button type="submit" variant="primary" size="xs" disabled={secretMutation.isPending || !secretValue.trim()}>
            {secretMutation.isPending ? (
              <>
                <LottieIcon kind="loading" size={12} color="var(--brand-on)" />
                解锁中…
              </>
            ) : (
              '解锁'
            )}
          </Button>
        </form>
      )}

      {failed && (
        <div className="flex flex-wrap items-center gap-2">
          {/* 后端 error_message 是英文技术原文，只当细节放小字，正文说清楚出了什么事 */}
          <p className="text-[11.5px] text-[var(--danger)]">解析这封邮件时出错，流水没有生成。</p>
          {errorText && <p className="text-[10.5px] text-[var(--text-tertiary)]">{errorText}</p>}
        </div>
      )}

      {!needsSecret && !failed && (
        <p className="text-[11.5px] text-[var(--text-secondary)]">只看这封邮件解析出的流水。</p>
      )}

      <span className="ml-auto flex items-center gap-1.5">
        <Button variant="soft" size="xs" disabled={retryMutation.isPending} onClick={() => void retry()}>
          {retryMutation.isPending ? '重新解析中…' : '重新解析'}
        </Button>
        <Menu>
          <MenuButton as="div">
            <IconButton label={`${mailSubject(task, '这封邮件')} 的操作`} className="size-6">
              <DotsThree aria-hidden className="size-4" weight="bold" />
            </IconButton>
          </MenuButton>
          <MenuItems
            anchor="bottom end"
            transition
            className="z-200 mt-1 min-w-44 rounded-md bg-[var(--surface-2)] py-1 shadow-[var(--shadow-pop)] ring-1 ring-[var(--border-subtle)] transition focus:outline-none data-closed:scale-95 data-closed:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in"
          >
            <MenuItem disabled={retryMutation.isPending}>
              <button type="button" onClick={() => void retry()} className={`${DROPDOWN_ITEM} text-[var(--text-primary)]`}>
                <ArrowsClockwise aria-hidden className="size-4" />
                重新解析
              </button>
            </MenuItem>
            <MenuItem>
              <button
                type="button"
                onClick={() => setIgnoreOpen(true)}
                className={`${DROPDOWN_ITEM} text-[var(--danger)] data-focus:bg-[var(--danger-soft)]`}
              >
                <Prohibit aria-hidden className="size-4" />
                忽略这封邮件
              </button>
            </MenuItem>
          </MenuItems>
        </Menu>
      </span>

      <Modal
        open={ignoreOpen}
        onClose={() => setIgnoreOpen(false)}
        title="忽略这封邮件"
        footer={
          <>
            <Button variant="secondary" size="md" onClick={() => setIgnoreOpen(false)}>
              留在收件箱
            </Button>
            <Button variant="danger" size="md" disabled={archiveMutation.isPending} onClick={() => void ignoreMail()}>
              {archiveMutation.isPending ? '忽略中…' : '忽略这封邮件'}
            </Button>
          </>
        }
      >
        <p>
          这封邮件会从收件箱移走，它名下
          {attrs.row_counts.pending > 0 ? ` ${attrs.row_counts.pending} 笔` : ''}
          还没入账的流水一并进「已忽略」，在那里可以逐笔恢复。已入账的交易不受影响，
          原始邮件和附件都保留。
        </p>
      </Modal>

      {/* 提交密码前的确认。上一步的干跑没把密码发出去，这一步才真提交。 */}
      <Modal
        open={unlockPreview !== null}
        onClose={() => setUnlockPreview(null)}
        title="确认提交密码"
        footer={
          <>
            <Button variant="secondary" size="md" onClick={() => setUnlockPreview(null)}>
              先不提交
            </Button>
            <Button
              variant="primary"
              size="md"
              disabled={secretMutation.isPending || !secretValue.trim()}
              onClick={() => void confirmUnlock()}
            >
              {secretMutation.isPending ? '提交中…' : '确认提交'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2">
          <p>{unlockPreview}</p>
          <p className="text-[11.5px] text-[var(--text-secondary)]">
            这一步只是预览，密码还没发出去。确认后才会提交给这份账单并重新解析。
          </p>
        </div>
      </Modal>
    </div>
  )
}
