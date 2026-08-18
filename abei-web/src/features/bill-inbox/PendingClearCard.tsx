import type { ReactNode } from 'react'
import { ArrowsClockwise } from '@phosphor-icons/react'
import { Button } from '../../components/ui/Button'
import { LottieIcon } from '../../components/abei/LottieIcon'
import * as copy from './copy'

/**
 * 待处理层清空之后的完成态。
 *
 * 两节都空的时候原来摆的是两个空节：「没有待入账的流水」和「没有待确认的流水」。
 * 一次干完的结果被说成两处缺席，而且两个空态各带一颗按钮，把人往两个方向支。
 * 整层换成一块：一句「清完了」，一句最近成果，两个出口。
 *
 * 要人动手的邮件横幅不归这里管——那是渠道层的事，它照常显示在这块上方。
 * 邮箱那头还有几封在等密码，不代表这一层的队列没清完。
 */
export function PendingClearCard({
  imported,
  dismissed,
  showTally,
  lastSync,
  syncing,
  note,
  onSync,
  onViewDone,
}: {
  imported: number
  dismissed: number
  /** 汇总还没加载出来 / 加载失败时传 false：那时候的 0 是「还不知道」，印出来是假的 */
  showTally: boolean
  /** 「12 分钟前」这种相对时间，同步正在跑时传 null */
  lastSync: string | null
  syncing: boolean
  /**
   * 当前筛选说明（「只看：招商银行」+ 看全部）。筛着一个渠道时这一句必须在：
   * 少了它，「清完了」说的是这个渠道，人读成的是整箱，而且没有回到全部的路。
   */
  note?: ReactNode
  onSync: () => void
  onViewDone: () => void
}) {
  const tally = showTally ? copy.pendingClearTally(imported, dismissed) : null
  const sub = [tally, lastSync ? copy.lastSyncNote(lastSync) : null].filter(Boolean).join(' · ')

  return (
    <div className="flex flex-col items-center justify-center gap-3 py-14 text-center">
      <LottieIcon kind="success" size={40} />
      <p className="text-sm font-semibold text-[var(--text-primary)]">{copy.PENDING_CLEAR_TITLE}</p>
      {sub !== '' && <p className="num max-w-sm text-[11.5px] text-[var(--text-tertiary)]">{sub}</p>}
      {note}
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button variant="secondary" size="sm" onClick={onViewDone}>
          {copy.PENDING_CLEAR_GOTO_DONE}
        </Button>
        <Button variant="ghost" size="sm" disabled={syncing} onClick={onSync}>
          <ArrowsClockwise aria-hidden className={`size-4 ${syncing ? 'animate-spin' : ''}`} />
          {syncing ? copy.SYNC_BUTTON_BUSY : copy.PENDING_CLEAR_SYNC}
        </Button>
      </div>
    </div>
  )
}
