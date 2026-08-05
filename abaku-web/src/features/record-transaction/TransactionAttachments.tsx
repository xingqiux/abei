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

  async function remove(id: string, name: string) {
    if (!window.confirm(`删除附件“${name}”？`)) return
    try {
      await deleteMutation.mutateAsync(id)
      showToast({ kind: 'success', message: '附件已删除' })
    } catch (error) {
      showToast({ kind: 'error', message: error instanceof FireflyApiError ? error.message : '附件删除失败' })
    }
  }

  return (
    <>
      <section className="mt-3 border-t pt-3 border-[var(--border-subtle)] ">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[11.5px] text-[var(--text-secondary)] "><PaperClipIcon aria-hidden className="size-3.5" />附件</span>
        <label className="cursor-pointer rounded-[5px] px-2 py-1 text-[11.5px] bg-[var(--surface-hover)]  text-[var(--brand)] ">
          {createMutation.isPending ? '上传中…' : '添加附件'}
          <input type="file" accept={about.data?.data.attachment_mime_types?.join(',')} className="sr-only" disabled={createMutation.isPending} onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.currentTarget.value = '' }} />
        </label>
      </div>
      {query.isLoading ? (
        <span className="text-[11.5px] text-[var(--text-secondary)] ">附件加载中…</span>
      ) : query.isError ? (
        <div className="flex items-center justify-between text-[11.5px] text-[var(--danger)] "><span>附件加载失败</span><button type="button" onClick={() => void query.refetch()} style={{ color: 'var(--brand)' }}>重试</button></div>
      ) : (
        <div className="flex flex-col gap-1">
          {(query.data?.data ?? []).map((attachment) => {
            const attrs = attachment.attributes
            const name = attrs.title || attrs.filename
            return (
              <div key={attachment.id} className="flex min-h-7 items-center gap-2 rounded-[4px] px-1.5 hover:bg-[var(--surface-hover)]">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[11.5px] text-[var(--text-primary)] ">{name}</div>
                  {(attrs.title && attrs.title !== attrs.filename || attrs.notes) && <div className="truncate text-[10.5px] text-[var(--text-secondary)] ">{attrs.filename}{attrs.notes ? ` · ${attrs.notes}` : ''}</div>}
                </div>
                <span className="font-mono tabular-nums text-[10.5px] text-[var(--text-secondary)] ">{attrs.size > 0 ? `${Math.ceil(attrs.size / 1024)} KB` : '待上传'}</span>
                <button type="button" title="下载附件" aria-label={`下载 ${name}`} onClick={() => void download(attachment.id, attrs.filename)} className="rounded p-1 text-[var(--brand)] "><ArrowDownTrayIcon aria-hidden className="size-3" /></button>
                <button type="button" title="编辑附件信息" aria-label={`编辑 ${name}`} onClick={() => setDraft({ id: attachment.id, filename: attrs.filename, title: attrs.title || attrs.filename, notes: attrs.notes || '' })} className="rounded p-1 text-[var(--text-secondary)] "><PencilIcon aria-hidden className="size-3" /></button>
                <button type="button" title="删除附件" aria-label={`删除 ${name}`} onClick={() => void remove(attachment.id, name)} className="rounded p-1 text-[var(--danger)] "><TrashIcon aria-hidden className="size-3" /></button>
              </div>
            )
          })}
          {query.isSuccess && query.data.data.length === 0 && <span className="text-[11.5px] text-[var(--text-secondary)] ">无附件</span>}
        </div>
      )}
      </section>
      <Modal open={draft !== null} onClose={() => setDraft(null)} title="编辑附件信息" width={420} footer={<>
        <button type="button" disabled={updateMutation.isPending} onClick={() => setDraft(null)} className="rounded-[6px] px-3 py-1.5 text-[12px] text-[var(--text-secondary)] ">取消</button>
        <button type="button" disabled={updateMutation.isPending} onClick={() => void saveMetadata()} className="rounded-[6px] px-3 py-1.5 text-[12px] disabled:opacity-50 bg-[var(--brand)] text-white font-semibold shadow-sm hover:bg-[var(--brand-hover)]">{updateMutation.isPending ? '保存中…' : '保存'}</button>
      </>}>
        {draft && <div className="flex flex-col gap-3 text-[12px]">
          <label className="flex flex-col gap-1 text-[var(--text-secondary)] ">文件名<input autoFocus value={draft.filename} onChange={(event) => setDraft({ ...draft, filename: event.target.value })} className="rounded-[6px] px-2.5 py-1.5 bg-[var(--surface-hover)]  text-[var(--text-primary)] " style={{ border: '1px solid var(--border-subtle)' }} /></label>
          <label className="flex flex-col gap-1 text-[var(--text-secondary)] ">标题<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} className="rounded-[6px] px-2.5 py-1.5 bg-[var(--surface-hover)]  text-[var(--text-primary)] " style={{ border: '1px solid var(--border-subtle)' }} /></label>
          <label className="flex flex-col gap-1 text-[var(--text-secondary)] ">备注<textarea rows={3} value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} className="resize-y rounded-[6px] px-2.5 py-1.5 bg-[var(--surface-hover)]  text-[var(--text-primary)] " style={{ border: '1px solid var(--border-subtle)' }} /></label>
        </div>}
      </Modal>
    </>
  )
}
