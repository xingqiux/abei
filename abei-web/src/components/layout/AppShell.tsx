import { Outlet, useRouterState } from '@tanstack/react-router'
import { useEffect } from 'react'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'
import { PageTransition } from './PageTransition'
import { BottomTabBar } from './BottomTabBar'
import { MoreSheet } from './MoreSheet'
import { ToastContainer } from '../abei/Toast'
import { DateRangePreferenceSync } from '../DateRangePreferenceSync'
import { RecordTransactionModal } from '../../features/record-transaction/RecordTransactionModal'
import { CommandPalette } from '../../features/command-palette/CommandPalette'
import { usePrivacyStore } from '../../store/privacyStore'

export function AppShell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const togglePrivacy = usePrivacyStore((s) => s.toggle)

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey && e.key.toLowerCase() === 'p') {
        e.preventDefault() // 不 preventDefault 会触发浏览器打印
        togglePrivacy()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [togglePrivacy])

  return (
    <div className="flex h-full w-full">
      <DateRangePreferenceSync />
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main className="min-w-0 flex-1 overflow-y-auto bg-[var(--surface-0)] px-4 py-6 pb-28 md:px-8 md:pb-8 ">
          <div className="mx-auto w-full max-w-[1440px]">
            <PageTransition key={pathname}>
              <Outlet />
            </PageTransition>
          </div>
        </main>
      </div>
      <ToastContainer />
      {/* 全局挂载：负责快捷键 n 与顶栏「+ 记一笔」共用的表单弹层（规范 §4.3） */}
      <RecordTransactionModal />
      {/* 全局挂载：命令面板，负责 Cmd+K/Ctrl+K/`/` 快捷键与顶栏搜索框入口（规范 §5） */}
      <CommandPalette />
      {/* 移动端底部 5 tab 与「我的」sheet（规范 §3 移动端断点） */}
      <BottomTabBar />
      <MoreSheet />
    </div>
  )
}
