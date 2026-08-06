import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArchiveBoxIcon, PencilIcon, PlusIcon } from '@heroicons/react/24/outline'
import { FireflyApiError, fireflyDelete, fireflyPost, fireflyPut } from '../../api/client'
import { getCategories, getTags } from '../../api/firefly'
import type { Category, Tag } from '../../api/schemas'
import { Modal } from '../../components/abaku/Modal'
import { ErrorState } from '../../components/abaku/ErrorState'
import { Skeleton } from '../../components/abaku/Skeleton'
import { Button, IconButton } from '../../components/ui/Button'
import { Field, Input } from '../../components/ui/Field'
import { StackedList, StackedListItem } from '../../components/ui/Card'
import { Tabs } from '../../components/ui/Tabs'
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

function baseState(kind: Kind): EditState {
  return { kind, name: '' }
}

function nameOf(kind: Kind, item: Category | Tag): string {
  return kind === 'category' ? (item as Category).attributes.name : (item as Tag).attributes.tag
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

  function openEdit(kind: Kind, item: Category | Tag) {
    setEdit({ kind, id: item.id, name: nameOf(kind, item) })
  }

  async function save() {
    if (!edit?.name.trim()) {
      showToast({ kind: 'error', message: '名称不能为空' })
      return
    }
    const suffix = edit.kind === 'category' ? 'categories' : 'tags'
    const body = edit.kind === 'category' ? { name: edit.name.trim() } : { tag: edit.name.trim() }
    setPending(true)
    try {
      if (edit.id == null) await fireflyPost(`/api/v1/${suffix}`, body)
      else await fireflyPut(`/api/v1/${suffix}/${edit.id}`, body)
      await queryClient.invalidateQueries({ queryKey: ['reference-data'] })
      await queryClient.invalidateQueries({ queryKey: [suffix] })
      showToast({ kind: 'success', message: edit.id == null ? '已创建' : '已更新' })
      setEdit(null)
    } catch (reason) {
      showToast({
        kind: 'error',
        message: reason instanceof FireflyApiError ? reason.message : '保存失败',
        duration: 6000,
      })
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
      showToast({
        kind: 'error',
        message: reason instanceof FireflyApiError ? reason.message : '归档失败',
        duration: 6000,
      })
    } finally {
      setPending(false)
    }
  }

  if (query.isLoading) return <Skeleton className="h-28" />
  if (query.isError) {
    return <ErrorState message="基础资料加载失败" onRetry={() => void query.refetch()} />
  }

  const data = query.data as ReferenceData
  const rows: Array<Category | Tag> = tab === 'category' ? data.categories : data.tags
  const noun = tab === 'category' ? '分类' : '标签'

  return (
    <>
      <div className="flex flex-col">
        <Tabs
          aria-label="基础资料类型"
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'category', label: '分类', count: data.categories.length },
            { value: 'tag', label: '标签', count: data.tags.length },
          ]}
          action={
            <Button
              variant="primary"
              size="xs"
              className="mb-2"
              onClick={() => setEdit(baseState(tab))}
            >
              <PlusIcon aria-hidden className="size-4" />
              新建{noun}
            </Button>
          }
        />

        {rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-[var(--text-secondary)]">还没有{noun}</p>
        ) : (
          // 行不各自带边框，靠 StackedList 的 divide-y 分隔；
          // -mx-4 抵掉 Card 的内边距，让 hover 底色铺满整行宽度
          <StackedList className="-mx-4 mt-1">
            {rows.map((item) => (
              <StackedListItem key={item.id}>
                <span className="min-w-0 truncate text-sm text-[var(--text-primary)]">
                  {nameOf(tab, item)}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <IconButton
                    label={`编辑${noun}「${nameOf(tab, item)}」`}
                    onClick={() => openEdit(tab, item)}
                  >
                    <PencilIcon aria-hidden className="size-4" />
                  </IconButton>
                  <IconButton
                    label={`归档${noun}「${nameOf(tab, item)}」`}
                    disabled={pending}
                    onClick={() => void archive(tab, item)}
                  >
                    <ArchiveBoxIcon aria-hidden className="size-4" />
                  </IconButton>
                </span>
              </StackedListItem>
            ))}
          </StackedList>
        )}
      </div>

      <Modal
        open={edit != null}
        onClose={() => setEdit(null)}
        title={edit?.id == null ? '新建基础资料' : '编辑基础资料'}
        width={440}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEdit(null)}>
              取消
            </Button>
            <Button variant="primary" disabled={pending} onClick={() => void save()}>
              {pending ? '保存中…' : '保存'}
            </Button>
          </>
        }
      >
        {edit && (
          <Field label={edit.kind === 'category' ? '分类名称' : '标签名称'}>
            <Input
              autoFocus
              value={edit.name}
              onChange={(event) => setEdit({ ...edit, name: event.target.value })}
            />
          </Field>
        )}
      </Modal>
    </>
  )
}
