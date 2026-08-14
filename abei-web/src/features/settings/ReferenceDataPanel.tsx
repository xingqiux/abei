import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, PencilSimple, Plus, TagSimple } from '@phosphor-icons/react'
import { AbeiApiError, apiDelete, apiPost, apiPut, viaFirefly } from '../../api/client'
import { getTags } from '../../api/firefly'
import type { Tag } from '../../api/schemas'
import { Modal } from '../../components/abei/Modal'
import { EmptyState } from '../../components/abei/EmptyState'
import { ErrorState } from '../../components/abei/ErrorState'
import { Skeleton } from '../../components/abei/Skeleton'
import { Button, IconButton } from '../../components/ui/Button'
import { Field, Input } from '../../components/ui/Field'
import { StackedList, StackedListItem } from '../../components/ui/Card'
import { showToast } from '../../store/toastStore'

/**
 * 标签管理。v0.2 分类那半边搬去了 features/reference-data 的分类树，
 * 标签这半边行为原样保留：建、改名、归档，三件事。
 */

interface EditState {
  id?: string
  name: string
}

export function ReferenceDataPanel() {
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: ['reference-data'], queryFn: () => getTags() })
  const [edit, setEdit] = useState<EditState | null>(null)
  const [pending, setPending] = useState(false)

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['reference-data'] })
    await queryClient.invalidateQueries({ queryKey: ['tags'] })
  }

  async function save() {
    if (!edit?.name.trim()) {
      showToast({ kind: 'error', message: '名称不能为空' })
      return
    }
    setPending(true)
    try {
      const body = { tag: edit.name.trim() }
      if (edit.id == null) await apiPost(viaFirefly('/api/v1/tags'), body)
      else await apiPut(viaFirefly(`/api/v1/tags/${edit.id}`), body)
      await refresh()
      showToast({ message: edit.id == null ? '已创建' : '已更新' })
      setEdit(null)
    } catch (reason) {
      showToast({
        kind: 'error',
        message: reason instanceof AbeiApiError ? reason.message : '保存失败',
        duration: 6000,
      })
    } finally {
      setPending(false)
    }
  }

  async function archive(item: Tag) {
    setPending(true)
    try {
      await apiDelete(viaFirefly(`/api/v1/tags/${item.id}`))
      await refresh()
      showToast({ message: '已归档' })
    } catch (reason) {
      showToast({
        kind: 'error',
        message: reason instanceof AbeiApiError ? reason.message : '归档失败',
        duration: 6000,
      })
    } finally {
      setPending(false)
    }
  }

  if (query.isLoading) return <Skeleton className="h-28" />
  if (query.isError) {
    return <ErrorState message="标签加载失败" error={query.error} onRetry={() => void query.refetch()} />
  }

  const rows = query.data?.data ?? []

  return (
    <>
      <div className="flex flex-col">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-[var(--text-secondary)]">
            标签跨分类使用，归档不影响已有交易。
          </p>
          <Button variant="secondary" size="xs" onClick={() => setEdit({ name: '' })}>
            <Plus aria-hidden className="size-4" />
            新建标签
          </Button>
        </div>

        {rows.length === 0 ? (
          <EmptyState
            compact
            icon={<TagSimple className="size-7" />}
            message="还没有标签。标签用来给交易打上跨分类的记号，比如「报销」「旅行」"
            action={{ label: '新建标签', onClick: () => setEdit({ name: '' }) }}
          />
        ) : (
          // 行不各自带边框，靠 StackedList 的 divide-y 分隔；
          // -mx-4 抵掉 Card 的内边距，让 hover 底色铺满整行宽度
          <StackedList className="-mx-4 mt-3">
            {rows.map((item) => (
              <StackedListItem key={item.id}>
                <span className="min-w-0 truncate text-sm text-[var(--text-primary)]">
                  {item.attributes.tag}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <IconButton
                    label={`编辑标签「${item.attributes.tag}」`}
                    onClick={() => setEdit({ id: item.id, name: item.attributes.tag })}
                  >
                    <PencilSimple aria-hidden className="size-4" />
                  </IconButton>
                  <IconButton
                    label={`归档标签「${item.attributes.tag}」`}
                    disabled={pending}
                    onClick={() => void archive(item)}
                  >
                    <Archive aria-hidden className="size-4" />
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
        title={edit?.id == null ? '新建标签' : '编辑标签'}
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
          <Field label="标签名称">
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
