import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react'
import type { ReactNode } from 'react'

/**
 * 下拉菜单。取自 tailwind-plus `elements/dropdowns/simple`，交互全交给 headlessui：
 * 键盘上下选、Esc 关闭、点外面关闭、焦点归还触发器——这些手写基本都会漏。
 *
 * `transition` + `data-closed:` 是 headlessui v2 的进出场写法，
 * 不需要额外的 Transition 组件包一层。
 */
export function Dropdown({
  trigger,
  children,
  align = 'right',
}: {
  trigger: ReactNode
  children: ReactNode
  align?: 'left' | 'right'
}) {
  return (
    <Menu as="div" className="relative inline-block">
      <MenuButton as="div">{trigger}</MenuButton>
      <MenuItems
        transition
        className={`absolute z-20 mt-2 min-w-44 origin-top rounded-md bg-[var(--surface-2)] py-1 shadow-[var(--shadow-pop)] ring-1 ring-[var(--border-subtle)] transition focus:outline-none data-closed:scale-95 data-closed:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in ${align === 'right' ? 'right-0 origin-top-right' : 'left-0 origin-top-left'}`}
      >
        {children}
      </MenuItems>
    </Menu>
  )
}

/**
 * 菜单项。`data-focus:` 是 headlessui 给「键盘或鼠标当前落在这一项」的状态，
 * 比自己维护 hover + activeIndex 可靠。
 */
export function DropdownItem({
  children,
  onClick,
  danger = false,
  disabled = false,
}: {
  children: ReactNode
  onClick: () => void
  /** 删除类操作，用深红 */
  danger?: boolean
  disabled?: boolean
}) {
  return (
    <MenuItem disabled={disabled}>
      <button
        type="button"
        onClick={onClick}
        className={`${DROPDOWN_ITEM} ${danger ? 'text-[var(--danger)] data-focus:bg-[var(--danger-soft)]' : 'text-[var(--text-primary)]'}`}
      >
        {children}
      </button>
    </MenuItem>
  )
}

/** 菜单项的样式。链接型菜单项（router Link）自己套 MenuItem 时复用它 */
export const DROPDOWN_ITEM =
  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ' +
  'data-focus:bg-[var(--surface-hover)] data-focus:outline-none data-disabled:opacity-50'

export function DropdownDivider() {
  return <div className="my-1 h-px bg-[var(--border-subtle)]" />
}

export { MenuItem }
