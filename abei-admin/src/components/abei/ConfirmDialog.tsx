import type { ReactNode } from 'react'
import { Modal } from './Modal'
import { Button } from '../ui/Button'

/**
 * 破坏性操作的确认框。
 *
 * 每个删除各自拿 Modal 拼一遍「取消 + 危险按钮」的时候，几处已经飘了：
 * 有的进行中禁用两颗按钮、有的只禁用一颗，按钮文案有「删除」也有「确认删除」。
 * 用户在不同页面看到的不是同一句话，就得每次重新读一遍才敢点。
 *
 * 说清楚三件事是这个组件的硬性要求，写在类型上：
 * `title` 说要做什么、`children` 说会丢什么（对象名和数量）、`confirmLabel` 说点下去发生什么。
 * 只写「确定吗？」的确认框等于没有确认。
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  pendingLabel,
  cancelLabel = '取消',
  pending = false,
  tone = 'danger',
  onConfirm,
  onClose,
}: {
  open: boolean
  title: string
  /** 会丢什么。带上对象名和数量，别只写「此操作不可撤销」。 */
  children: ReactNode
  confirmLabel: string
  /** 进行中的按钮文案，缺省是 `${confirmLabel}中…` */
  pendingLabel?: string
  cancelLabel?: string
  pending?: boolean
  /** 删除类用 danger；断开连接、放弃草稿这类可以重来的用 primary。 */
  tone?: 'danger' | 'primary'
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Modal
      open={open}
      // 进行中不让点外面关：请求已经发出去了，关掉只会让人以为没删成。
      onClose={pending ? () => {} : onClose}
      title={title}
      width={420}
      footer={
        <>
          <Button variant="secondary" size="md" disabled={pending} onClick={onClose}>
            {cancelLabel}
          </Button>
          <Button variant={tone} size="md" disabled={pending} onClick={onConfirm}>
            {pending ? (pendingLabel ?? `${confirmLabel}中…`) : confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2 text-[var(--text-secondary)]">{children}</div>
    </Modal>
  )
}
