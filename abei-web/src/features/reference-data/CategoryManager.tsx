import { useState } from 'react'
import {
  CaretDown,
  CaretRight,
  DotsThreeVertical,
  Eye,
  EyeSlash,
  FolderSimple,
  Palette,
  PencilSimple,
  Plus,
  Question,
  Trash,
} from '@phosphor-icons/react'
import { AbeiApiError } from '../../api/client'
import {
  useCategories,
  useCategoryStats,
  useCreateCategory,
  useDeleteCategory,
  useUpdateCategory,
} from '../../api/queries'
import type { Category, CategoryDomain } from '../../api/schemas'
import { CategoryIcon } from '../../components/abei/CategoryIcon'
import { ErrorState } from '../../components/abei/ErrorState'
import { Skeleton } from '../../components/abei/Skeleton'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { Dropdown, DropdownDivider, DropdownItem } from '../../components/ui/Dropdown'
import { showToast } from '../../store/toastStore'
import { CategoryIconColorDialog, type IconColorValue } from './CategoryIconColorDialog'
import { CategoryEditDialog, DeleteCategoryDialog, MoveGroupDialog } from './CategoryDialogs'
import { CategoryTopCards } from './CategoryTopCards'
import {
  DOMAIN_HINTS,
  DOMAIN_LABELS,
  DOMAIN_ORDER,
  buildDomainTree,
  domainOf,
  formatLastUsed,
  groupOptions,
  isDisabled,
  isSystem,
  subtreeUsage,
  usageIndex,
  usageOf,
  type CategoryNode,
  type CategoryUsage,
} from './categoryTree'

/**
 * 分类管理页的分类半边：按域分三段，段内两级树。
 *
 * 「未分类」不是一条真分类，是交易没挂分类的那个状态（Firefly 原生）。
 * 界面上给它一行虚拟行，好让人看见有多少笔待处理，但它不可编辑——
 * 一旦做成真分类，就会同时存在「挂了未分类」和「没挂分类」两种事实，对不上账。
 */

interface EditState {
  mode: 'create' | 'rename'
  domain: CategoryDomain
  id?: string
  name: string
  parentId: string | null
}

export function CategoryManager() {
  const categoriesQuery = useCategories({ includeDisabled: true })
  const statsQuery = useCategoryStats()
  const createCategory = useCreateCategory()
  const updateCategory = useUpdateCategory()
  const deleteCategory = useDeleteCategory()

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [edit, setEdit] = useState<EditState | null>(null)
  const [iconTarget, setIconTarget] = useState<Category | null>(null)
  const [moveTarget, setMoveTarget] = useState<Category | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Category | null>(null)
  const [needsMigration, setNeedsMigration] = useState(false)

  if (categoriesQuery.isLoading) return <Skeleton className="h-64" />
  if (categoriesQuery.isError) {
    return <ErrorState message="分类加载失败" error={categoriesQuery.error} onRetry={() => void categoriesQuery.refetch()} />
  }

  const categories = categoriesQuery.data?.data ?? []
  const usage = usageIndex(statsQuery.data)
  const uncategorizedCount = statsQuery.data?.uncategorized_count ?? 0

  function toggleCollapsed(id: string) {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function reportFailure(reason: unknown, fallback: string) {
    showToast({
      kind: 'error',
      message: reason instanceof AbeiApiError ? reason.message : fallback,
      duration: 6000,
    })
  }

  function submitEdit(input: { name: string; parentId: string | null }) {
    if (!edit) return
    if (edit.mode === 'create') {
      createCategory.mutate(
        { name: input.name, domain: edit.domain, parent_id: input.parentId },
        {
          onSuccess: () => {
            showToast({ message: `已建好「${input.name}」` })
            setEdit(null)
          },
          onError: (reason) => reportFailure(reason, '新建失败'),
        },
      )
      return
    }
    updateCategory.mutate(
      { id: edit.id as string, attrs: { name: input.name } },
      {
        onSuccess: () => {
          showToast({ message: '已改名' })
          setEdit(null)
        },
        onError: (reason) => reportFailure(reason, '改名失败'),
      },
    )
  }

  function submitIconColor(next: IconColorValue) {
    if (!iconTarget) return
    updateCategory.mutate(
      { id: iconTarget.id, attrs: { icon: next.icon, color: next.color } },
      {
        onSuccess: () => {
          showToast({ message: '已换图标' })
          setIconTarget(null)
        },
        onError: (reason) => reportFailure(reason, '保存失败'),
      },
    )
  }

  function submitMove(parentId: string | null) {
    if (!moveTarget) return
    updateCategory.mutate(
      { id: moveTarget.id, attrs: { parent_id: parentId } },
      {
        onSuccess: () => {
          showToast({ message: '已换组' })
          setMoveTarget(null)
        },
        onError: (reason) => reportFailure(reason, '换组失败'),
      },
    )
  }

  function toggleDisabled(category: Category) {
    const disabled = !isDisabled(category)
    updateCategory.mutate(
      { id: category.id, attrs: { disabled } },
      {
        onSuccess: () =>
          showToast({
            message: disabled
              ? `「${category.attributes.name}」已停用，历史交易不受影响`
              : `「${category.attributes.name}」已启用`,
          }),
        onError: (reason) => reportFailure(reason, '操作失败'),
      },
    )
  }

  function openDelete(category: Category) {
    setDeleteTarget(category)
    setNeedsMigration(false)
  }

  /**
   * 删除。名下还有交易时后端回 422 —— 那不是「出错了」，是「还差一步」，
   * 所以把弹层就地换成迁移选择，而不是弹个红字让人自己猜下一步。
   */
  function confirmDelete(migrateTo: string | undefined) {
    if (!deleteTarget) return
    deleteCategory.mutate(
      { id: deleteTarget.id, migrateTo },
      {
        onSuccess: () => {
          showToast({ message: `已删除「${deleteTarget.attributes.name}」` })
          setDeleteTarget(null)
          setNeedsMigration(false)
        },
        onError: (reason) => {
          if (reason instanceof AbeiApiError && reason.status === 422 && !migrateTo) {
            setNeedsMigration(true)
            return
          }
          reportFailure(reason, '删除失败')
        },
      },
    )
  }

  const editGroups = edit ? groupOptions(categories, edit.domain) : []
  const moveGroups = moveTarget ? groupOptions(categories, domainOf(moveTarget)) : []

  return (
    <div className="flex flex-col gap-4">
      <CategoryTopCards uncategorizedCount={uncategorizedCount} />

      {DOMAIN_ORDER.map((domain) => {
        const tree = buildDomainTree(categories, domain)
        const groups = groupOptions(categories, domain)
        return (
          <Card key={domain} padded={false}>
            <div className="flex items-start justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                  {DOMAIN_LABELS[domain]}
                </h2>
                <p className="mt-0.5 text-xs text-[var(--text-secondary)]">{DOMAIN_HINTS[domain]}</p>
              </div>
              <Button
                variant="secondary"
                size="xs"
                onClick={() =>
                  setEdit({ mode: 'create', domain, name: '', parentId: null })
                }
              >
                <Plus aria-hidden className="size-4" />
                新建
              </Button>
            </div>

            {tree.length === 0 && domain !== 'expense' ? (
              <p className="px-4 pb-6 text-center text-sm text-[var(--text-secondary)]">
                这一段还没有分类
              </p>
            ) : (
              <ul role="list" className="divide-y divide-[var(--border-subtle)] border-t border-[var(--border-subtle)]">
                {tree.map((node) => (
                  <CategoryTreeRows
                    key={node.category.id}
                    node={node}
                    collapsed={collapsed.has(node.category.id)}
                    usageOfId={(id) => usageOf(usage, id)}
                    groupUsage={subtreeUsage(usage, node)}
                    canMoveWithinDomain={groups.length > 0}
                    onToggleCollapsed={() => toggleCollapsed(node.category.id)}
                    onRename={(category) =>
                      setEdit({
                        mode: 'rename',
                        domain,
                        id: category.id,
                        name: category.attributes.name,
                        parentId: null,
                      })
                    }
                    onIcon={setIconTarget}
                    onMove={setMoveTarget}
                    onToggleDisabled={toggleDisabled}
                    onDelete={openDelete}
                  />
                ))}
                {domain === 'expense' && <UncategorizedRow count={uncategorizedCount} />}
              </ul>
            )}
          </Card>
        )
      })}

      <CategoryEditDialog
        open={edit != null}
        mode={edit?.mode ?? 'create'}
        domain={edit?.domain ?? 'expense'}
        initialName={edit?.name ?? ''}
        initialParentId={edit?.parentId ?? null}
        groupOptions={editGroups}
        pending={createCategory.isPending || updateCategory.isPending}
        onClose={() => setEdit(null)}
        onSubmit={submitEdit}
      />

      <CategoryIconColorDialog
        open={iconTarget != null}
        title={iconTarget ? `「${iconTarget.attributes.name}」的图标和颜色` : '图标和颜色'}
        value={{ icon: iconTarget?.attributes.icon ?? null, color: iconTarget?.attributes.color ?? null }}
        pending={updateCategory.isPending}
        onClose={() => setIconTarget(null)}
        onSubmit={submitIconColor}
      />

      <MoveGroupDialog
        open={moveTarget != null}
        category={moveTarget}
        groupOptions={moveGroups}
        pending={updateCategory.isPending}
        onClose={() => setMoveTarget(null)}
        onSubmit={submitMove}
      />

      <DeleteCategoryDialog
        open={deleteTarget != null}
        category={deleteTarget}
        allCategories={categories}
        needsMigration={needsMigration}
        pending={deleteCategory.isPending}
        onClose={() => {
          setDeleteTarget(null)
          setNeedsMigration(false)
        }}
        onConfirm={confirmDelete}
      />
    </div>
  )
}

interface RowActions {
  onRename: (category: Category) => void
  onIcon: (category: Category) => void
  onMove: (category: Category) => void
  onToggleDisabled: (category: Category) => void
  onDelete: (category: Category) => void
}

function CategoryTreeRows({
  node,
  collapsed,
  usageOfId,
  groupUsage,
  canMoveWithinDomain,
  onToggleCollapsed,
  ...actions
}: RowActions & {
  node: CategoryNode
  collapsed: boolean
  usageOfId: (id: string) => CategoryUsage
  groupUsage: CategoryUsage
  canMoveWithinDomain: boolean
  onToggleCollapsed: () => void
}) {
  const hasChildren = node.children.length > 0
  return (
    <>
      <CategoryRow
        category={node.category}
        usage={hasChildren ? groupUsage : usageOfId(node.category.id)}
        depth={0}
        collapsible={hasChildren}
        collapsed={collapsed}
        childCount={node.children.length}
        // 组本身不换组：一级就是域的直属，再往上没有地方可去
        canMove={!hasChildren && canMoveWithinDomain}
        onToggleCollapsed={onToggleCollapsed}
        {...actions}
      />
      {!collapsed &&
        node.children.map((child) => (
          <CategoryRow
            key={child.id}
            category={child}
            usage={usageOfId(child.id)}
            depth={1}
            collapsible={false}
            collapsed={false}
            childCount={0}
            canMove={canMoveWithinDomain}
            onToggleCollapsed={() => {}}
            {...actions}
          />
        ))}
    </>
  )
}

function CategoryRow({
  category,
  usage,
  depth,
  collapsible,
  collapsed,
  childCount,
  canMove,
  onToggleCollapsed,
  onRename,
  onIcon,
  onMove,
  onToggleDisabled,
  onDelete,
}: RowActions & {
  category: Category
  usage: CategoryUsage
  depth: 0 | 1
  collapsible: boolean
  collapsed: boolean
  childCount: number
  canMove: boolean
  onToggleCollapsed: () => void
}) {
  const name = category.attributes.name
  const system = isSystem(category)
  const disabled = isDisabled(category)

  return (
    <li
      className="flex items-center gap-2 px-4 transition-colors hover:bg-[var(--surface-hover)]"
      style={{ minHeight: 'var(--row-h)', paddingLeft: depth === 1 ? 40 : undefined }}
    >
      {collapsible ? (
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={collapsed ? `展开「${name}」的子分类` : `折叠「${name}」的子分类`}
          onClick={onToggleCollapsed}
          className="flex size-5 shrink-0 items-center justify-center rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
        >
          {collapsed ? <CaretRight aria-hidden className="size-4" /> : <CaretDown aria-hidden className="size-4" />}
        </button>
      ) : (
        depth === 0 && <span aria-hidden className="size-5 shrink-0" />
      )}

      <CategoryIcon icon={category.attributes.icon} color={category.attributes.color} size={20} />

      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span
          className={`truncate text-sm ${disabled ? 'text-[var(--text-tertiary)] line-through' : 'text-[var(--text-primary)]'}`}
        >
          {name}
        </span>
        {childCount > 0 && (
          <span className="num shrink-0 text-xs text-[var(--text-tertiary)]">{childCount} 个子分类</span>
        )}
        {disabled && (
          <span className="shrink-0 rounded-full bg-[var(--surface-hover)] px-2 py-0.5 text-xs text-[var(--text-secondary)]">
            已停用
          </span>
        )}
      </span>

      <span className="hidden shrink-0 text-xs text-[var(--text-secondary)] sm:block">
        近一年 <span className="num">{usage.count}</span> 笔
      </span>
      <span className="hidden w-24 shrink-0 text-right text-xs text-[var(--text-tertiary)] md:block">
        {formatLastUsed(usage.lastUsedAt)}
      </span>

      <Dropdown
        trigger={
          <button
            type="button"
            aria-label={`「${name}」的操作`}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          >
            <DotsThreeVertical aria-hidden className="size-4" />
          </button>
        }
      >
        {/* 出厂分类也可改名（改名后 AI 会停用指向旧名的规则并说明原因） */}
        <DropdownItem onClick={() => onRename(category)}>
          <PencilSimple aria-hidden className="size-4" />
          改名
        </DropdownItem>
        <DropdownItem onClick={() => onIcon(category)}>
          <Palette aria-hidden className="size-4" />
          换图标颜色
        </DropdownItem>
        {canMove && (
          <DropdownItem onClick={() => onMove(category)}>
            <FolderSimple aria-hidden className="size-4" />
            换组
          </DropdownItem>
        )}
        <DropdownDivider />
        <DropdownItem onClick={() => onToggleDisabled(category)}>
          {disabled ? <Eye aria-hidden className="size-4" /> : <EyeSlash aria-hidden className="size-4" />}
          {disabled ? '启用' : '停用'}
        </DropdownItem>
        <DropdownItem danger disabled={system} onClick={() => onDelete(category)}>
          <Trash aria-hidden className="size-4" />
          {system ? '删除（出厂分类不可删）' : '删除'}
        </DropdownItem>
      </Dropdown>
    </li>
  )
}

/** 「未分类」虚拟行：只报数，不给任何编辑入口 */
function UncategorizedRow({ count }: { count: number }) {
  return (
    <li className="flex items-center gap-2 px-4" style={{ minHeight: 'var(--row-h)' }}>
      <span aria-hidden className="size-5 shrink-0" />
      <span className="flex size-5 shrink-0 items-center justify-center">
        <Question aria-hidden className="size-5 text-[var(--text-tertiary)]" />
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate text-sm text-[var(--text-secondary)]">未分类</span>
        <span className="shrink-0 text-xs text-[var(--text-tertiary)]">
          未归入任何分类的交易，非真实分类，不可编辑
        </span>
      </span>
      <span className="hidden shrink-0 text-xs text-[var(--text-secondary)] sm:block">
        <span className="num">{count}</span> 笔
      </span>
      <span aria-hidden className="hidden w-24 shrink-0 md:block" />
      <span aria-hidden className="size-7 shrink-0" />
    </li>
  )
}
