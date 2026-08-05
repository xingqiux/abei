import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArchiveBoxIcon, PencilIcon, PlusIcon } from '@heroicons/react/24/outline'
import { FireflyApiError, fireflyDelete, fireflyPost, fireflyPut } from '../../api/client'
import { getCategories, getTags } from '../../api/firefly'
import type { Category, Tag } from '../../api/schemas'
import { Modal } from '../../components/granary/Modal'
import { ErrorState } from '../../components/granary/ErrorState'
import { Skeleton } from '../../components/granary/Skeleton'
import { showToast } from '../../store/toastStore'

type Kind = 'category' | 'tag'

interface ReferenceData {
  categories: Category[]
  tags: Tag[]
}

interface EditState {
  kind: Kind
  id?: string
  name: string
}

const inputStyle = {
  background: 'light-dark(var(--color-gray-100), var(--color-gray-700))',
  color: 'light-dark(var(--color-gray-900), var(--color-gray-100))',
  border: '1px solid light-dark(var(--color-gray-200), var(--color-gray-600))',
} as const

function baseState(kind: Kind): EditState {
  return {
    kind,
    name: '',
  }
}

async function loadReferenceData(): Promise<ReferenceData> {
  const [categories, tags] = await Promise.all([getCategories(), getTags()])
  return { categories: categories.data, tags: tags.data }
}

export function ReferenceDataPanel() {
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: ['reference-data'], queryFn: loadReferenceData })
  const [tab, setTab] = useState<Kind>('category')
  const [edit, setEdit] = useState<EditState | null>(null)
  const [pending, setPending] = useState(false)

  function openCreate(kind: Kind) {
    setEdit(baseState(kind))
  }

  function openEdit(kind: Kind, item: Category | Tag) {
    const next = baseState(kind)
    next.id = item.id
    next.name = kind === 'category' ? (item as Category).attributes.name : (item as Tag).attributes.tag
    setEdit(next)
  }

  async function save() {
    if (!edit?.name.trim()) {
      showToast({ kind: 'error', message: '名称不能为空' })
      return
    }
    const suffix = edit.kind === 'category' ? 'categories' : 'tags'
    const body = edit.kind === 'category'
      ? { name: edit.name.trim() }
      : { tag: edit.name.trim() }
    setPending(true)
    try {
      if (edit.id == null) await fireflyPost(`/api/v1/${suffix}`, body)
      else await fireflyPut(`/api/v1/${suffix}/${edit.id}`, body)
      await queryClient.invalidateQueries({ queryKey: ['reference-data'] })
      await queryClient.invalidateQueries({ queryKey: [suffix] })
      showToast({ kind: 'success', message: edit.id == null ? '已创建' : '已更新' })
      setEdit(null)
    } catch (reason) {
      showToast({ kind: 'error', message: reason instanceof FireflyApiError ? reason.message : '保存失败', duration: 6000 })
    } finally {
      setPending(false)
    }
  }

  async function archive(kind: Kind, item: Category | Tag) {
    const suffix = kind === 'category' ? 'categories' : 'tags'
    setPending(true)
    try {
      await fireflyDelete(`/api/v1/${suffix}/${item.id}`)
      await queryClient.invalidateQueries({ queryKey: ['reference-data'] })
      await queryClient.invalidateQueries({ queryKey: [suffix] })
      showToast({ kind: 'success', message: '已归档' })
    } catch (reason) {
      showToast({ kind: 'error', message: reason instanceof FireflyApiError ? reason.message : '归档失败', duration: 6000 })
    } finally {
      setPending(false)
    }
  }

  if (query.isLoading) return <Skeleton className="h-28" />
  if (query.isError) return <ErrorState message="基础资料加载失败" onRetry={() => void query.refetch()} />

  const data = query.data as ReferenceData
  const rows: Array<Category | Tag> = tab === 'category' ? data.categories : data.tags

  return (
    <>
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex gap-0.5 rounded-[6px] p-0.5 bg-gray-100 dark:bg-gray-700">
            {([['category', '分类'], ['tag', '标签']] as const).map(([value, label]) => <button key={value} type="button" onClick={() => setTab(value)} className="rounded-[4px] px-3 py-1.5 text-[12px]" style={{ background: tab === value ? 'light-dark(var(--color-indigo-600), var(--color-indigo-500))' : 'transparent', color: tab === value ? 'var(--color-white)' : 'light-dark(var(--color-gray-500), var(--color-gray-400))' }}>{label}</button>)}
          </div>
          <button type="button" title="新建" aria-label="新建" onClick={() => openCreate(tab)} className="rounded p-1.5 text-indigo-600 dark:text-indigo-400"><PlusIcon aria-hidden className="size-4" /></button>
        </div>
        <div className="flex flex-col">
          {rows.length === 0 && <div className="py-5 text-center text-[12px] text-gray-500 dark:text-gray-400">暂无数据</div>}
          {rows.map((item) => (
            <div key={item.id} className="flex min-h-9 items-center gap-2 border-b px-1 last:border-b-0 border-gray-200 dark:border-gray-700">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] text-gray-900 dark:text-gray-100">{tab === 'category' ? (item as Category).attributes.name : (item as Tag).attributes.tag}</div>
                <div className="text-[10.5px] text-gray-500 dark:text-gray-400">{tab === 'category' ? '分类' : '标签'}</div>
              </div>
              <button type="button" title="编辑" aria-label={`编辑 ${item.id}`} onClick={() => openEdit(tab, item)} className="rounded p-1 text-gray-500 dark:text-gray-400"><PencilIcon aria-hidden className="size-3.5" /></button>
              <button type="button" title="归档" aria-label={`归档 ${item.id}`} disabled={pending} onClick={() => void archive(tab, item)} className="rounded p-1 disabled:opacity-50 text-gray-500 dark:text-gray-400"><ArchiveBoxIcon aria-hidden className="size-3.5" /></button>
            </div>
          ))}
        </div>
      </div>

      <Modal open={edit != null} onClose={() => setEdit(null)} title={edit?.id == null ? '新建基础资料' : '编辑基础资料'} width={440} footer={<>
        <button type="button" onClick={() => setEdit(null)} className="rounded-[6px] px-3 py-1.5 text-[12.5px] text-gray-500 dark:text-gray-400">取消</button>
        <button type="button" disabled={pending} onClick={() => void save()} className="rounded-[6px] px-3 py-1.5 text-[12.5px] disabled:opacity-50 bg-indigo-600 text-white font-semibold shadow-sm hover:bg-indigo-500">{pending ? '保存中...' : '保存'}</button>
      </>}>
        {edit && <div className="flex flex-col gap-3">
          <Field label="名称"><input autoFocus value={edit.name} onChange={(event) => setEdit({ ...edit, name: event.target.value })} className="rounded-[6px] px-2.5 py-1.5" style={inputStyle} /></Field>
        </div>}
      </Modal>
    </>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="flex flex-col gap-1 text-[12px] text-gray-500 dark:text-gray-400"><span>{label}</span>{children}</label>
}
