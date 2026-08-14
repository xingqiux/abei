import type { ReactNode } from 'react'
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react'
import { X } from '@phosphor-icons/react'
import { IconButton } from '../ui/Button'

/**
 * 通用确认/信息弹层。
 * 传送门、焦点陷阱、滚动锁定、Esc 关闭、点外面关闭都交给 @headlessui/react 的 Dialog。
 * 破坏性操作确认框（忽略任务等）必须在 children 里写明对象名与数量。
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 440,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
  width?: number
}) {
  return (
    <Dialog open={open} onClose={onClose} className="relative z-200">
      <div
        aria-hidden
        className="fixed inset-0 bg-black/50 transition-opacity duration-240 ease-out data-closed:opacity-0 motion-reduce:transition-none"
      />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel
          transition
          style={{ maxWidth: width }}
          className="flex max-h-[86vh] w-full flex-col rounded-xl bg-[var(--surface-1)] shadow-2xl ring-1 ring-[var(--border-subtle)] transition duration-240 ease-out data-closed:-translate-y-2 data-closed:scale-98 data-closed:opacity-0 motion-reduce:transition-none  "
        >
          <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-4 py-3">
            <DialogTitle className="text-sm font-semibold text-[var(--text-primary)]">
              {title}
            </DialogTitle>
            <IconButton label="关闭" className="size-7 -mr-1" onClick={onClose}>
              <X aria-hidden className="size-4" />
            </IconButton>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-[13px] text-[var(--text-primary)]">
            {children}
          </div>
          {/* 底部按钮在窄屏上排成一列并撑满：并排两颗 96px 的按钮在 360px 宽的手机上
              会挤到只剩两个字，误点相邻按钮的代价在这里通常是「删掉了东西」 */}
          {footer && (
            <div className="flex flex-col-reverse gap-2 border-t border-[var(--border-subtle)] px-4 py-3 sm:flex-row sm:justify-end [&>button]:w-full sm:[&>button]:w-auto">
              {footer}
            </div>
          )}
        </DialogPanel>
      </div>
    </Dialog>
  )
}
