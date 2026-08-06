import type { BillTask } from '../../api/schemas'
import { useIgnoreBillTask } from '../../api/queries'
import { Modal } from '../../components/abaku/Modal'
import { showToast } from '../../store/toastStore'
import { Button } from '../../components/ui/Button'

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
          <Button variant="secondary" size="md" onClick={onCancel}>
            取消
          </Button>
          <Button variant="danger" size="md" disabled={ignoreMutation.isPending} onClick={handleConfirm}>
            {ignoreMutation.isPending ? '处理中…' : '确认忽略'}
          </Button>
        </>
      }
    >
      <p>
        确认忽略任务「<span className="font-semibold">{title}</span>」？该任务下{' '}
        <span className="font-mono tabular-nums">{total}</span> 条流水将不再出现在待处理列表中，此操作不可撤销。
      </p>
    </Modal>
  )
}
