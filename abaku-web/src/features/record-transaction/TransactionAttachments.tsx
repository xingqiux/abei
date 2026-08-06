import { useState } from 'react'
import { ArrowDownTrayIcon, PaperClipIcon, PencilIcon, TrashIcon } from '@heroicons/react/24/outline'
import {
  useCreateTransactionAttachment,
  useDeleteAttachment,
  useAbout,
  useTransactionAttachments,
  useUpdateAttachment,
} from '../../api/queries'
import { downloadAttachment } from '../../api/firefly'
import { FireflyApiError } from '../../api/client'
import { showToast } from '../../store/toastStore'
import { Modal } from '../../components/abaku/Modal'
import { InlineError } from '../../components/abaku/ErrorState'
import { Button, IconButton } from '../../components/ui/Button'
import { Field, Input, Textarea } from '../../components/ui/Field'

interface AttachmentDraft {
  id: string
  filename: string
  title: string
  notes: string
}

export function TransactionAttachments({ groupId, journalId }: { groupId: string; journalId: string }) {
  const query = useTransactionAttachments(groupId)
  const about = useAbout()
  const createMutation = useCreateTransactionAttachment()
  const updateMutation = useUpdateAttachment()
  const deleteMutation = useDeleteAttachment()
  const [draft, setDraft] = useState<AttachmentDraft | null>(null)
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null)

  async function upload(file: File) {
    const maxSize = about.data?.data.attachment_upload_size
    const mimeTypes = about.data?.data.attachment_mime_types
    if (maxSize && file.size > maxSize) {
      showToast({ kind: 'error', message: `附件不能超过 ${Math.floor(maxSize / 1024 / 1024)} MB` })
      return
    }
    if (mimeTypes && !mimeTypes.includes(file.type)) {
      showToast({ kind: 'error', message: '不支持此附件类型' })
      return
    }
    try {
      await createMutation.mutateAsync({ journalId, file })
      showToast({ kind: 'success', message: '附件已上传' })
    } catch (error) {
      showToast({ kind: 'error', message: error instanceof FireflyApiError ? error.message : '附件上传失败', duration: 6000 })
    }
  }

  async function download(id: string, fallbackName: string) {
    try {
      const result = await downloadAttachment(id)
      const url = URL.createObjectURL(result.blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = result.filename || fallbackName
      anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 0)
    } catch (error) {
      showToast({ kind: 'error', message: error instanceof FireflyApiError ? error.message : '附件下载失败', duration: 6000 })
    }
  }

  async function saveMetadata() {
    if (!draft) return
    if (!draft.filename.trim() || !draft.title.trim()) {
      showToast({ kind: 'error', message: '文件名和标题不能为空' })
      return
    }
    try {
      await updateMutation.mutateAsync({
        attachmentId: draft.id,
        input: {
          filename: draft.filename.trim(),
          title: draft.title.trim(),
          notes: draft.notes.trim(),
        },
      })
      setDraft(null)
      showToast({ kind: 'success', message: '附件信息已更新' })
    } catch (error) {
      showToast({ kind: 'error', message: error instanceof FireflyApiError ? error.message : '附件更新失败' })
    }
  }

  async function remove() {
    if (!pendingDelete) return
    try {
      await deleteMutation.mutateAsync(pendingDelete.id)
      setPendingDelete(null)
      showToast({ kind: 'success', message: '附件已删除' })
    } catch (error) {
      showToast({ kind: 'error', message: error instanceof FireflyApiError ? error.message : '附件删除失败' })
    }
  }

  const attachments = query.data?.data ?? []

  return (
    <>
      <section className="mt-3 border-t border-[var(--border-subtle)] pt-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-[11.5px] text-[var(--text-secondary)]">
            <PaperClipIcon aria-hidden className="size-3.5" />附件
          </span>
          {/* 文件选择只能由 <label> 触发，所以这里不是按钮而是 label。
              focus-within 是它唯一的聚焦反馈——真正被聚焦的是里面那个 sr-only 的 input */}
          <label className="inline-flex cursor-pointer items-center rounded-md bg-[var(--surface-hover)] px-2 py-1 text-[11.5px] font-semibold text-[var(--brand-text)] transition-colors hover:bg-[var(--surface-selected)] focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--focus-ring)]">
            {createMutation.isPending ? '上传中…' : '添加附件'}
            <input
              type="file"
              accept={about.data?.data.attachment_mime_types?.join(',')}
              className="sr-only"
              disabled={createMutation.isPending}
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void upload(file)
                event.currentTarget.value = ''
              }}
            />
          </label>
        </div>

        {query.isLoading ? (
          <span role="status" className="text-[11.5px] text-[var(--text-secondary)]">附件加载中…</span>
        ) : query.isError ? (
          <InlineError message="附件加载失败" onRetry={() => void query.refetch()} />
        ) : attachments.length === 0 ? (
          <span className="text-[11.5px] text-[var(--text-secondary)]">无附件</span>
        ) : (
          <ul role="list" className="flex flex-col gap-1">
            {attachments.map((attachment) => {
              const attrs = attachment.attributes
              const name = attrs.title || attrs.filename
              const subtitle = (attrs.title && attrs.title !== attrs.filename) || attrs.notes
                ? `${attrs.filename}${attrs.notes ? ` · ${attrs.notes}` : ''}`
                : null
              return (
                <li key={attachment.id} className="flex min-h-7 items-center gap-1 rounded px-1.5 hover:bg-[var(--surface-hover)]">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[11.5px] text-[var(--text-primary)]">{name}</div>
                    {subtitle && <div className="truncate text-[10.5px] text-[var(--text-secondary)]">{subtitle}</div>}
                  </div>
                  <span className="font-mono text-[10.5px] tabular-nums text-[var(--text-secondary)]">
                    {attrs.size > 0 ? `${Math.ceil(attrs.size / 1024)} KB` : '待上传'}
                  </span>
                  <IconButton label={`下载 ${name}`} className="size-6" onClick={() => void download(attachment.id, attrs.filename)}>
                    <ArrowDownTrayIcon aria-hidden className="size-3.5" />
                  </IconButton>
                  <IconButton
                    label={`编辑 ${name}`}
                    className="size-6"
                    onClick={() => setDraft({ id: attachment.id, filename: attrs.filename, title: attrs.title || attrs.filename, notes: attrs.notes || '' })}
                  >
                    <PencilIcon aria-hidden className="size-3.5" />
                  </IconButton>
                  <IconButton label={`删除 ${name}`} variant="ghost-danger" className="size-6" onClick={() => setPendingDelete({ id: attachment.id, name })}>
                    <TrashIcon aria-hidden className="size-3.5" />
                  </IconButton>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <Modal
        open={draft !== null}
        onClose={() => setDraft(null)}
        title="编辑附件信息"
        width={420}
        footer={
          <>
            <Button variant="secondary" size="md" disabled={updateMutation.isPending} onClick={() => setDraft(null)}>取消</Button>
            <Button variant="primary" size="md" disabled={updateMutation.isPending} onClick={() => void saveMetadata()}>
              {updateMutation.isPending ? '保存中…' : '保存'}
            </Button>
          </>
        }
      >
        {draft && (
          <div className="flex flex-col gap-3">
            <Field label="文件名">
              <Input autoFocus value={draft.filename} onChange={(event) => setDraft({ ...draft, filename: event.target.value })} />
            </Field>
            <Field label="标题">
              <Input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
            </Field>
            <Field label="备注">
              <Textarea rows={3} className="resize-y" value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} />
            </Field>
          </div>
        )}
      </Modal>

      {/* 原先是 window.confirm：不受主题控制，在移动端浏览器里样子也各不相同 */}
      <Modal
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title="删除附件"
        width={380}
        footer={
          <>
            <Button variant="secondary" size="md" onClick={() => setPendingDelete(null)}>取消</Button>
            <Button variant="danger" size="md" onClick={() => void remove()}>删除</Button>
          </>
        }
      >
        <p className="text-[var(--text-secondary)]">
          将删除附件「{pendingDelete?.name}」，文件本身会从 Firefly 移除，不能撤销。
        </p>
      </Modal>
    </>
  )
}
