import { useEffect, useState } from 'react'
import { Check } from '@phosphor-icons/react'
import type { Category, CategoryDomain } from '../../api/schemas'
import { CategoryIcon } from '../../components/abei/CategoryIcon'
import { Modal } from '../../components/abei/Modal'
import { Button } from '../../components/ui/Button'
import { Field, Input } from '../../components/ui/Field'
import { DOMAIN_LABELS, fullPath } from './categoryTree'

/**
 * 分类管理页的三个弹层：新建/改名、换组、删除。
 * 选项列表一律用可选中的行而不是原生 select——原生 select 在深色主题下是系统皮肤，
 * 和整页对不上，也没法带图标色点。
 */

/** 一份可选项列表。选中项左边打勾，不靠颜色单独表意 */
function OptionList({
  options,
  value,
  onChange,
  emptyText,
}: {
  options: Array<{ value: string; label: string; icon?: string | null; color?: string | null }>
  value: string | null
  onChange: (next: string) => void
  emptyText: string
}) {
  if (options.length === 0) {
    return <p className="py-6 text-center text-sm text-[var(--text-secondary)]">{emptyText}</p>
  }
  return (
    <ul role="list" className="max-h-64 overflow-y-auto rounded-md ring-1 ring-[var(--border-subtle)]">
      {options.map((option) => (
        <li key={option.value}>
          <button
            type="button"
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
            className={`flex w-full items-center gap-2 px-3 text-left text-sm transition-colors hover:bg-[var(--surface-hover)] ${
              value === option.value ? 'bg-[var(--brand-soft)] text-[var(--brand-text)]' : 'text-[var(--text-primary)]'
            }`}
            style={{ minHeight: 'var(--row-h)' }}
          >
            {option.icon !== undefined && <CategoryIcon icon={option.icon} color={option.color} size={20} />}
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            {value === option.value && <Check aria-hidden className="size-4 shrink-0" />}
          </button>
        </li>
      ))}
    </ul>
  )
}

/** 新建分类 / 改名。出厂分类同样可改名。 */
export function CategoryEditDialog({
  open,
  mode,
  domain,
  initialName,
  initialParentId,
  groupOptions,
  pending,
  onClose,
  onSubmit,
}: {
  open: boolean
  mode: 'create' | 'rename'
  domain: CategoryDomain
  initialName: string
  initialParentId: string | null
  /** 可挂靠的一级组；为空表示这个域不分组 */
  groupOptions: Category[]
  pending: boolean
  onClose: () => void
  onSubmit: (input: { name: string; parentId: string | null }) => void
}) {
  const [name, setName] = useState(initialName)
  const [parentId, setParentId] = useState<string | null>(initialParentId)

  useEffect(() => {
    if (!open) return
    setName(initialName)
    setParentId(initialParentId)
  }, [open, initialName, initialParentId])

  const canPickGroup = mode === 'create' && groupOptions.length > 0

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={mode === 'create' ? `在「${DOMAIN_LABELS[domain]}」新建分类` : '改名'}
      width={440}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={pending || name.trim() === ''}
            onClick={() => onSubmit({ name: name.trim(), parentId })}
          >
            {pending ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="名称">
          <Input autoFocus value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        {canPickGroup && (
          <div>
            <p className="mb-2 text-xs font-medium text-[var(--text-secondary)]">归属组</p>
            <OptionList
              options={[
                { value: '', label: '不挂组，作为一级分类' },
                ...groupOptions.map((group) => ({
                  value: group.id,
                  label: group.attributes.name,
                  icon: group.attributes.icon,
                  color: group.attributes.color,
                })),
              ]}
              value={parentId ?? ''}
              onChange={(next) => setParentId(next === '' ? null : next)}
              emptyText="这个域还没有组"
            />
          </div>
        )}
      </div>
    </Modal>
  )
}

/** 换组：只能在同一个域内换，跨域换等于改口径，那是另一件事 */
export function MoveGroupDialog({
  open,
  category,
  groupOptions,
  pending,
  onClose,
  onSubmit,
}: {
  open: boolean
  category: Category | null
  groupOptions: Category[]
  pending: boolean
  onClose: () => void
  onSubmit: (parentId: string | null) => void
}) {
  const [parentId, setParentId] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !category) return
    const raw = category.attributes.parent_id
    setParentId(raw == null || raw === '' ? null : String(raw))
  }, [open, category])

  return (
    <Modal
      open={open && category != null}
      onClose={onClose}
      title={category ? `把「${category.attributes.name}」换到` : '换组'}
      width={440}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={pending} onClick={() => onSubmit(parentId)}>
            {pending ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      <OptionList
        options={[
          { value: '', label: '不挂组，作为一级分类' },
          ...groupOptions
            .filter((group) => group.id !== category?.id)
            .map((group) => ({
              value: group.id,
              label: group.attributes.name,
              icon: group.attributes.icon,
              color: group.attributes.color,
            })),
        ]}
        value={parentId ?? ''}
        onChange={(next) => setParentId(next === '' ? null : next)}
        emptyText="这个域还没有别的组"
      />
    </Modal>
  )
}

/**
 * 删除确认。名下还有交易时后端会拒（422），这时弹层变成「先把交易迁到哪里」，
 * 选完再删。不给「连交易一起删」这个选项——那是无法撤销的数据损失。
 */
export function DeleteCategoryDialog({
  open,
  category,
  allCategories,
  needsMigration,
  pending,
  onClose,
  onConfirm,
}: {
  open: boolean
  category: Category | null
  allCategories: Category[]
  needsMigration: boolean
  pending: boolean
  onClose: () => void
  onConfirm: (migrateTo: string | undefined) => void
}) {
  const [migrateTo, setMigrateTo] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setMigrateTo(null)
  }, [open, category])

  const targets = category
    ? allCategories.filter(
        (item) => item.id !== category.id && item.attributes.domain === category.attributes.domain,
      )
    : []

  return (
    <Modal
      open={open && category != null}
      onClose={onClose}
      title={needsMigration ? '迁移交易' : '删除分类'}
      width={460}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="danger"
            disabled={pending || (needsMigration && !migrateTo)}
            onClick={() => onConfirm(migrateTo ?? undefined)}
          >
            {pending ? '处理中…' : needsMigration ? '迁移并删除' : '删除'}
          </Button>
        </>
      }
    >
      {category && (
        <div className="flex flex-col gap-3">
          {needsMigration ? (
            <>
              <p className="text-sm text-[var(--text-secondary)]">
                「{category.attributes.name}」名下仍有交易，需先迁移到其他分类才能删除。
              </p>
              <OptionList
                options={targets.map((item) => ({
                  value: item.id,
                  label: fullPath(allCategories, item),
                  icon: item.attributes.icon,
                  color: item.attributes.color,
                }))}
                value={migrateTo}
                onChange={setMigrateTo}
                emptyText="同域内没有其他分类"
              />
            </>
          ) : (
            <p className="text-sm text-[var(--text-secondary)]">
              删除「{category.attributes.name}」。名下若有交易，需先选择迁移目标。
            </p>
          )}
        </div>
      )}
    </Modal>
  )
}
