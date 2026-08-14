import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { AbeiMark } from './AbeiMark'
import { LottieIcon, type LottieIconKind } from './LottieIcon'
import { Button, buttonClass } from '../ui/Button'

/**
 * 空态的出口。`onClick` 和 `to` 二选一：能当场做完的事给 onClick，
 * 要换个页面才能做的事给 to（渲染成真链接，中键能新开）。两个都给时以 to 为准。
 */
export interface EmptyStateAction {
  label: string
  onClick?: () => void
  /** 路由目标，如 `/accounts` */
  to?: string
}

/**
 * 空态。`action` 是必填的：一屏「暂无数据」而不给出口，等于把用户停在死路上，
 * 所以这里用类型逼着每个调用点想清楚「那现在该干什么」。
 */
export function EmptyState({
  icon = <AbeiMark className="size-8" />,
  statusIcon,
  message,
  action,
  compact = false,
}: {
  /** 静态占位图，任意节点（emoji、heroicon、自绘 svg）。 */
  icon?: ReactNode
  /** 语义状态图标（加载中/收件箱等），走 `LottieIcon`。 */
  statusIcon?: LottieIconKind
  message: string
  action: EmptyStateAction
  /** 列表或图表内部的紧凑空态。 */
  compact?: boolean
}) {
  const staticIcon = (
    <div className="flex h-full items-center justify-center text-[32px] text-[var(--text-tertiary)]" aria-hidden>
      {icon}
    </div>
  )

  return (
    <div
      className={`relative flex flex-col items-center justify-center text-center ${compact ? 'gap-2 py-6' : 'gap-3 py-16'}`}
    >
      {statusIcon ? (
        <LottieIcon kind={statusIcon} size={40} />
      ) : compact ? (
        <div className="h-10">{staticIcon}</div>
      ) : (
        // 非紧凑空态给一圈品牌浅底，页面大片留白时图标不至于孤零零悬着
        <div className="flex size-16 items-center justify-center rounded-full bg-[var(--brand-soft)]">{staticIcon}</div>
      )}
      <p className="max-w-sm text-sm text-[var(--text-secondary)]">{message}</p>
      {action.to ? (
        <Link to={action.to} onClick={action.onClick} className={buttonClass({ variant: 'primary', size: 'sm' })}>
          {action.label}
        </Link>
      ) : (
        <Button variant="primary" size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  )
}
