import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ShieldWarning } from '@phosphor-icons/react'
import { getSession } from '../api/feedback'
import { AbeiMark } from './abei/AbeiMark'
import { Button } from './ui/Button'
import { Card } from './ui/Card'
import { ErrorState } from './abei/ErrorState'

/**
 * 后台的门。整站只有 owner 能进，所以这道检查放在路由之前，而不是每个页面各写一遍——
 * 页面里各写一遍的写法只要漏掉一个新页面就是个洞，放在门口则是新页面默认受保护。
 *
 * 这不是安全边界，服务端 /v1/admin/* 自己校验 owner；这里只是别让非 owner 对着一屏 403 发呆。
 */
export function OwnerGate({ children }: { children: ReactNode }) {
  const session = useQuery({ queryKey: ['session'], queryFn: getSession })

  if (session.isLoading) {
    return (
      <Centered>
        <p className="text-[13px] text-[var(--text-secondary)]">正在确认管理权限…</p>
      </Centered>
    )
  }

  if (session.isError) {
    return (
      <Centered>
        <Card className="w-full max-w-md">
          <ErrorState
            message="无法确认管理权限"
            error={session.error}
            onRetry={() => void session.refetch()}
          />
        </Card>
      </Centered>
    )
  }

  if (session.data?.data.is_owner !== true) {
    return (
      <Centered>
        <Card className="flex w-full max-w-md flex-col items-center gap-3 py-10 text-center">
          <ShieldWarning className="size-9 text-[var(--text-tertiary)]" />
          <p className="text-[15px] font-semibold text-[var(--text-primary)]">这里只有管理员能进</p>
          <p className="max-w-xs text-[13px] leading-relaxed text-[var(--text-secondary)]">
            当前登录的是「{session.data?.data.actor || '未知账号'}」。
            记账、账单收件箱这些日常功能都在阿贝前台，这个后台只用来配置解析器、同步器和处理反馈。
          </p>
          <Button variant="secondary" size="sm" onClick={() => { window.location.href = '/' }}>
            重新登录
          </Button>
        </Card>
      </Centered>
    )
  }

  return children
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-[var(--surface-0)] p-4">
      <div className="flex items-center gap-2">
        <AbeiMark className="size-6" />
        <span className="text-[15px] font-semibold text-[var(--text-primary)]">阿贝后台</span>
      </div>
      {children}
    </div>
  )
}
