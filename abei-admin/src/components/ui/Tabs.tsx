import { Tab, TabGroup, TabList, TabPanel, TabPanels } from '@headlessui/react'
import type { ReactNode } from 'react'

/**
 * 分段切换。结构取自 tailwind-plus `navigation/tabs/bar-with-underline`，
 * 交互交给 headlessui `TabGroup`。
 *
 * 换掉的是散在各处的手写两颗按钮：那些既没有 role="tablist"、也不响应方向键，
 * 选中态是内联 style 直接改背景色。headlessui 负责 roving tabindex 和 aria，
 * 这里只管样式。
 */
export interface TabDef<T extends string> {
  value: T
  label: string
  /** 右上角计数，如收件箱待办数 */
  count?: number
}

interface TabsProps<T extends string> {
  tabs: readonly TabDef<T>[]
  value: T
  onChange: (value: T) => void
  'aria-label': string
  /** 右侧操作区，如「新建」按钮 */
  action?: ReactNode
}

/**
 * 受控 tabs。用下划线而不是填充块——填充块在密集页面里是第二个「按钮」，
 * 会和真正的主操作抢注意力。
 */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  'aria-label': ariaLabel,
  action,
}: TabsProps<T>) {
  const index = Math.max(0, tabs.findIndex((t) => t.value === value))
  return (
    <TabGroup
      selectedIndex={index}
      onChange={(next) => {
        const tab = tabs[next]
        if (tab) onChange(tab.value)
      }}
    >
      <div className="flex items-center justify-between gap-3 border-b border-[var(--border-subtle)]">
        <TabList aria-label={ariaLabel} className="-mb-px flex gap-6">
          {tabs.map((tab) => (
            <Tab
              key={tab.value}
              className="group flex items-center gap-2 border-b-2 border-transparent px-0.5 pb-2.5 text-sm font-medium whitespace-nowrap text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] focus:outline-none data-selected:border-[var(--brand)] data-selected:text-[var(--brand-text)]"
            >
              {tab.label}
              {tab.count != null && (
                <span className="num rounded-full bg-[var(--surface-hover)] px-1.5 py-0.5 text-xs text-[var(--text-secondary)] group-data-selected:bg-[var(--brand-soft)] group-data-selected:text-[var(--brand-text)]">
                  {tab.count}
                </span>
              )}
            </Tab>
          ))}
        </TabList>
        {action}
      </div>
    </TabGroup>
  )
}

/** 需要 headlessui 管面板时用这三个，简单场景直接用上面的受控 Tabs 自己渲染内容 */
export { TabGroup, TabList, TabPanel, TabPanels, Tab }
