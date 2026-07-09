import { Outlet, useRouterState } from '@tanstack/react-router'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'
import { PageTransition } from './PageTransition'
import { BottomTabBar } from './BottomTabBar'
import { MoreSheet } from './MoreSheet'
import { ToastContainer } from '../granary/Toast'
import { RecordTransactionModal } from '../../features/record-transaction/RecordTransactionModal'
import { CommandPalette } from '../../features/command-palette/CommandPalette'

export function AppShell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  return (
    <div className="flex h-full w-full">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        {/* 移动端左右 padding 收窄到 12px，底部留出底部 tab 高度（规范 §3 移动端断点） */}
        <main className="min-w-0 flex-1 overflow-y-auto px-3 py-5 pb-24 md:px-5 md:pb-5">
          <PageTransition key={pathname}>
            <Outlet />
          </PageTransition>
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
