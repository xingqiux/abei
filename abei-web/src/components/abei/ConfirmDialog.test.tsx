import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConfirmDialog } from './ConfirmDialog'

function setup(props: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  const onConfirm = vi.fn()
  const onClose = vi.fn()
  render(
    <ConfirmDialog
      open
      title="删除预算"
      confirmLabel="删除预算"
      onConfirm={onConfirm}
      onClose={onClose}
      {...props}
    >
      <p>确定删除预算「餐饮」？</p>
    </ConfirmDialog>,
  )
  return { onConfirm, onClose }
}

describe('ConfirmDialog', () => {
  it('确认和取消各自回调，正文说清楚会丢什么', () => {
    const { onConfirm, onClose } = setup()

    expect(screen.getByText('确定删除预算「餐饮」？')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '删除预算' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('进行中禁用两颗按钮，并且换成进行中的文案', () => {
    setup({ pending: true })

    // 只禁用危险按钮的话，用户会去点「取消」，以为能把已经发出去的请求撤回来。
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '删除预算中…' })).toBeDisabled()
  })

  it('pendingLabel 能覆盖默认的进行中文案', () => {
    setup({ pending: true, confirmLabel: '移入回收站', pendingLabel: '移动中…' })

    expect(screen.getByRole('button', { name: '移动中…' })).toBeInTheDocument()
  })
})
