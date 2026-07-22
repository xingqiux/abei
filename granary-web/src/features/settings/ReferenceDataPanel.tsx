import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, Pencil, Plus } from 'lucide-react'
import { FireflyApiError } from '../../api/client'
import { getActiveBookId, granaryDelete, granaryGet, granaryPost, granaryPut } from '../../api/granary'
import { Modal } from '../../components/granary/Modal'
import { ErrorState } from '../../components/granary/ErrorState'
import { Skeleton } from '../../components/granary/Skeleton'
import { showToast } from '../../store/toastStore'

type Kind = 'category' | 'tag' | 'counterparty'

interface Category {
  id: number
  name: string
  kind: 'income' | 'expense'
  parent_id: number | null
  version: number
}

interface Tag {
  id: number
  name: string
  color: string | null
  version: number
}

interface Counterparty {
  id: number
  name: string
  kind: 'merchant' | 'person' | 'institution' | 'other'
  review_status: 'confirmed' | 'unreviewed'
  notes: string | null
  version: number
}

interface ReferenceData {
  categories: Category[]
  tags: Tag[]
  counterparties: Counterparty[]
}

interface EditState {
  kind: Kind
  id?: number
  version?: number
  name: string
  categoryKind: Category['kind']
  parentId: string
  tagColor: string
  counterpartyKind: Counterparty['kind']
  notes: string
}

const inputStyle = {
  background: 'var(--g-surface-2)',
  color: 'var(--g-ink)',
  border: '1px solid var(--g-border)',
} as const

function baseState(kind: Kind): EditState {
  return {
    kind,
    name: '',
    categoryKind: 'expense',
    parentId: '',
    tagColor: '#577590',
    counterpartyKind: 'merchant',
    notes: '',
  }
}

function path(suffix: string): string {
  return `/api/v1/books/${getActiveBookId()}${suffix}`
}

async function loadReferenceData(): Promise<ReferenceData> {
  const [categories, tags, counterparties] = await Promise.all([
    granaryGet<Category[]>(path('/categories')),
    granaryGet<Tag[]>(path('/tags')),
    granaryGet<Counterparty[]>(path('/counterparties')),
  ])
  return { categories, tags, counterparties }
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

  function openEdit(kind: Kind, item: Category | Tag | Counterparty) {
    const next = baseState(kind)
    next.id = item.id
    next.version = item.version
    next.name = item.name
    if (kind === 'category') {
      const category = item as Category
      next.categoryKind = category.kind
      next.parentId = category.parent_id == null ? '' : String(category.parent_id)
    } else if (kind === 'tag') {
      next.tagColor = (item as Tag).color ?? '#577590'
    } else {
      const counterparty = item as Counterparty
      next.counterpartyKind = counterparty.kind
      next.notes = counterparty.notes ?? ''
    }
    setEdit(next)
  }

  async function save() {
    if (!edit?.name.trim()) {
      showToast({ kind: 'error', message: '名称不能为空' })
      return
    }
    const suffix = edit.kind === 'category' ? 'categories' : edit.kind === 'tag' ? 'tags' : 'counterparties'
    let body: Record<string, unknown>
    if (edit.kind === 'category') {
      body = {
        name: edit.name.trim(),
        kind: edit.categoryKind,
        parent_id: edit.parentId ? Number(edit.parentId) : null,
      }
    } else if (edit.kind === 'tag') {
      body = { name: edit.name.trim(), color: edit.tagColor || null }
    } else {
      body = {
        name: edit.name.trim(),
        kind: edit.counterpartyKind,
        review_status: 'confirmed',
        notes: edit.notes.trim() || null,
      }
    }
    if (edit.version != null) body.version = edit.version
    setPending(true)
    try {
      if (edit.id == null) await granaryPost(path(`/${suffix}`), body)
      else await granaryPut(path(`/${suffix}/${edit.id}`), body)
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

  async function archive(kind: Kind, item: Category | Tag | Counterparty) {
    const suffix = kind === 'category' ? 'categories' : kind === 'tag' ? 'tags' : 'counterparties'
    setPending(true)
    try {
      await granaryDelete(path(`/${suffix}/${item.id}`), { version: item.version })
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
  const rows: Array<Category | Tag | Counterparty> = tab === 'category'
    ? data.categories
    : tab === 'tag'
      ? data.tags
      : data.counterparties

  return (
    <>
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex gap-0.5 rounded-[6px] p-0.5" style={{ background: 'var(--g-surface-2)' }}>
            {([['category', '分类'], ['tag', '标签'], ['counterparty', '交易方']] as const).map(([value, label]) => <button key={value} type="button" onClick={() => setTab(value)} className="rounded-[4px] px-3 py-1.5 text-[12px]" style={{ background: tab === value ? 'var(--g-accent)' : 'transparent', color: tab === value ? 'var(--g-accent-ink)' : 'var(--g-ink-2)' }}>{label}</button>)}
          </div>
          <button type="button" title="新建" aria-label="新建" onClick={() => openCreate(tab)} className="rounded p-1.5" style={{ color: 'var(--g-accent)' }}><Plus size={16} /></button>
        </div>
        <div className="flex flex-col">
          {rows.length === 0 && <div className="py-5 text-center text-[12px]" style={{ color: 'var(--g-ink-2)' }}>暂无数据</div>}
          {rows.map((item) => (
            <div key={item.id} className="flex min-h-9 items-center gap-2 border-b px-1 last:border-b-0" style={{ borderColor: 'var(--g-border)' }}>
              {'color' in item && item.color && <span className="h-3 w-3 shrink-0 rounded-[3px]" style={{ background: item.color }} />}
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px]" style={{ color: 'var(--g-ink)' }}>{item.name}</div>
                <div className="text-[10.5px]" style={{ color: 'var(--g-ink-2)' }}>{rowMeta(tab, item, data.categories)}</div>
              </div>
              <button type="button" title="编辑" aria-label={`编辑 ${item.name}`} onClick={() => openEdit(tab, item)} className="rounded p-1" style={{ color: 'var(--g-ink-2)' }}><Pencil size={14} /></button>
              <button type="button" title="归档" aria-label={`归档 ${item.name}`} disabled={pending} onClick={() => void archive(tab, item)} className="rounded p-1 disabled:opacity-50" style={{ color: 'var(--g-ink-2)' }}><Archive size={14} /></button>
            </div>
          ))}
        </div>
      </div>

      <Modal open={edit != null} onClose={() => setEdit(null)} title={edit?.id == null ? '新建基础资料' : '编辑基础资料'} width={440} footer={<>
        <button type="button" onClick={() => setEdit(null)} className="rounded-[6px] px-3 py-1.5 text-[12.5px]" style={{ color: 'var(--g-ink-2)' }}>取消</button>
        <button type="button" disabled={pending} onClick={() => void save()} className="rounded-[6px] px-3 py-1.5 text-[12.5px] disabled:opacity-50" style={{ background: 'var(--g-accent)', color: 'var(--g-accent-ink)' }}>{pending ? '保存中...' : '保存'}</button>
      </>}>
        {edit && <div className="flex flex-col gap-3">
          <Field label="名称"><input autoFocus value={edit.name} onChange={(event) => setEdit({ ...edit, name: event.target.value })} className="rounded-[6px] px-2.5 py-1.5" style={inputStyle} /></Field>
          {edit.kind === 'category' && <>
            <Field label="收支类型"><select value={edit.categoryKind} onChange={(event) => setEdit({ ...edit, categoryKind: event.target.value as Category['kind'], parentId: '' })} className="rounded-[6px] px-2.5 py-1.5" style={inputStyle}><option value="expense">支出</option><option value="income">收入</option></select></Field>
            <Field label="上级分类"><select value={edit.parentId} onChange={(event) => setEdit({ ...edit, parentId: event.target.value })} className="rounded-[6px] px-2.5 py-1.5" style={inputStyle}><option value="">无</option>{data.categories.filter((category) => category.kind === edit.categoryKind && category.parent_id == null && category.id !== edit.id).map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></Field>
          </>}
          {edit.kind === 'tag' && <Field label="颜色"><div className="flex items-center gap-2"><input type="color" value={edit.tagColor} onChange={(event) => setEdit({ ...edit, tagColor: event.target.value })} className="h-8 w-10 rounded-[4px]" /><span className="font-num text-[11px]" style={{ color: 'var(--g-ink-2)' }}>{edit.tagColor}</span></div></Field>}
          {edit.kind === 'counterparty' && <>
            <Field label="类型"><select value={edit.counterpartyKind} onChange={(event) => setEdit({ ...edit, counterpartyKind: event.target.value as Counterparty['kind'] })} className="rounded-[6px] px-2.5 py-1.5" style={inputStyle}><option value="merchant">商户</option><option value="person">个人</option><option value="institution">机构</option><option value="other">其他</option></select></Field>
            <Field label="备注"><textarea rows={3} value={edit.notes} onChange={(event) => setEdit({ ...edit, notes: event.target.value })} className="resize-none rounded-[6px] px-2.5 py-1.5" style={inputStyle} /></Field>
          </>}
        </div>}
      </Modal>
    </>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="flex flex-col gap-1 text-[12px]" style={{ color: 'var(--g-ink-2)' }}><span>{label}</span>{children}</label>
}

function rowMeta(kind: Kind, item: Category | Tag | Counterparty, categories: Category[]): string {
  if (kind === 'category') {
    const category = item as Category
    const parent = categories.find((candidate) => candidate.id === category.parent_id)
    return `${category.kind === 'expense' ? '支出' : '收入'}${parent ? ` · ${parent.name}` : ''}`
  }
  if (kind === 'tag') return '标签'
  const counterparty = item as Counterparty
  return { merchant: '商户', person: '个人', institution: '机构', other: '其他' }[counterparty.kind]
}
