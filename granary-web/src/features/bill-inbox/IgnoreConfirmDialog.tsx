import type { BillTask } from '../../api/schemas'
import { useIgnoreBillTask } from '../../api/queries'
import { Modal } from '../../components/granary/Modal'
import { showToast } from '../../store/toastStore'

/** 破坏性操作确认框：必须写明对象名与数量（规范 §5） */
export function IgnoreConfirmDialog({
  open,
  task,
  onCancel,
  onIgnored,
}: {
  open: boolean
  task: BillTask
  onCancel: () => void
  onIgnored: () => void
}) {
  const ignoreMutation = useIgnoreBillTask()
  const title = task.attributes.summary ?? `任务 #${task.id}`
  const total = task.attributes.row_counts.total

  async function handleConfirm() {
    try {
      await ignoreMutation.mutateAsync(task.id)
      showToast({ message: `已忽略任务「${title}」`, kind: 'success' })
      onIgnored()
    } catch {
      showToast({ message: '忽略任务失败，请重试', kind: 'error' })
    }
  }

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title="忽略此任务"
      footer={
        <>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-[6px] px-3 py-1.5 text-[12.5px]"
            style={{ background: 'light-dark(var(--color-gray-100), var(--color-gray-700))', color: 'light-dark(var(--color-gray-900), var(--color-gray-100))' }}
          >
            取消
          </button>
          <button
            type="button"
            disabled={ignoreMutation.isPending}
            onClick={handleConfirm}
            className="rounded-[6px] px-3 py-1.5 text-[12.5px] disabled:opacity-50"
            style={{ background: 'light-dark(var(--color-red-600), var(--color-red-400))', color: '#fff', fontWeight: '600' }}
          >
            {ignoreMutation.isPending ? '处理中…' : '确认忽略'}
          </button>
        </>
      }
    >
      <div>
        确认忽略任务「<span style={{ fontWeight: '600' }}>{title}</span>」？该任务下{' '}
        <span className="font-mono tabular-nums">{total}</span> 条流水将不再出现在待处理列表中，此操作不可撤销。
      </div>
    </Modal>
  )
}
