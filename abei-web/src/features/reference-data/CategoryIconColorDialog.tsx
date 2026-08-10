import { useEffect, useMemo, useState } from 'react'
import { MagnifyingGlass } from '@phosphor-icons/react'
import { CategoryIcon } from '../../components/abei/CategoryIcon'
import { Modal } from '../../components/abei/Modal'
import { Button } from '../../components/ui/Button'
import { Field, Input } from '../../components/ui/Field'

/**
 * 图标和颜色的编辑弹层。
 *
 * 颜色存的是色板号（"1"~"12"）不是 hex：深浅两套主题各有一组 --cat-N，
 * 存死了 hex，换主题时分类色点就会和整页脱节。
 */

export const CATEGORY_COLORS = [
  { value: '1', label: '红' },
  { value: '2', label: '橙' },
  { value: '3', label: '黄' },
  { value: '4', label: '绿' },
  { value: '5', label: '青' },
  { value: '6', label: '蓝青' },
  { value: '7', label: '蓝' },
  { value: '8', label: '靛' },
  { value: '9', label: '紫' },
  { value: '10', label: '玫红' },
  { value: '11', label: '棕' },
  { value: '12', label: '灰' },
] as const

/**
 * 可选图标。这份名单必须是 CategoryIcon 认得的那一套的子集——
 * Phosphor 有一千五百个图标，但 CategoryIcon 只翻译白名单里的，
 * 名字对不上就静默退回问号。这里多列一个，用户就会挑到一个画不出来的图标。
 * Question 不在列表里：它是「未分类」和兜底专用，不给人手选。
 */
const ICON_CHOICES: readonly string[] = [
  // 餐饮
  'ForkKnife', 'BowlFood', 'Moped', 'Coffee', 'Cookie', 'Champagne',
  // 出行
  'Bus', 'Tram', 'Taxi', 'Bicycle', 'AirplaneTilt', 'Airplane', 'ChargingStation',
  // 居住
  'House', 'Key', 'Lightning', 'Hammer', 'Armchair',
  // 账单订阅
  'Receipt', 'WifiHigh', 'AppWindow', 'Crown',
  // 购物
  'ShoppingCart', 'Basket', 'TShirt', 'Laptop', 'ShoppingBag',
  // 健康
  'FirstAid', 'Pill', 'Barbell',
  // 文娱
  'GameController', 'FilmSlate', 'MusicNotes',
  // 学习
  'GraduationCap', 'Chalkboard', 'BookOpen',
  // 人情
  'Gift', 'HandHeart',
  // 金融
  'Bank', 'Percent', 'Scales', 'ShieldCheck', 'CreditCard', 'Coins', 'HandCoins',
  'TrendUp', 'ChartLineUp', 'ArrowsLeftRight', 'ArrowLineDown',
  // 收入与兜底
  'Briefcase', 'Wrench', 'DotsThreeCircle', 'DotsThree',
]

export interface IconColorValue {
  icon: string | null
  color: string | null
}

export function CategoryIconColorDialog({
  open,
  title,
  value,
  pending = false,
  onClose,
  onSubmit,
}: {
  open: boolean
  title: string
  value: IconColorValue
  pending?: boolean
  onClose: () => void
  onSubmit: (next: IconColorValue) => void
}) {
  const [icon, setIcon] = useState<string | null>(value.icon)
  const [color, setColor] = useState<string | null>(value.color)
  const [query, setQuery] = useState('')

  // 每次打开都从当前分类的值重新起头，不然上一次挑到一半的选择会串到下一个分类
  useEffect(() => {
    if (!open) return
    setIcon(value.icon)
    setColor(value.color)
    setQuery('')
  }, [open, value.icon, value.color])

  const icons = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return ICON_CHOICES
    return ICON_CHOICES.filter((name) => name.toLowerCase().includes(keyword))
  }, [query])

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={pending} onClick={() => onSubmit({ icon, color })}>
            {pending ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3 rounded-md bg-[var(--surface-hover)] px-3 py-2">
          <CategoryIcon icon={icon} color={color} size={24} />
          <span className="text-sm text-[var(--text-secondary)]">
            {icon ?? '未选图标'}
            {color ? ` · ${CATEGORY_COLORS.find((c) => c.value === color)?.label ?? color}` : ' · 未选颜色'}
          </span>
        </div>

        <div>
          <p className="mb-2 text-xs font-medium text-[var(--text-secondary)]">颜色</p>
          <div className="flex flex-wrap gap-2">
            {CATEGORY_COLORS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-label={`颜色 ${option.label}`}
                aria-pressed={color === option.value}
                onClick={() => setColor(option.value)}
                className={`size-7 rounded-full transition-transform hover:scale-110 ${
                  color === option.value
                    ? 'ring-2 ring-[var(--focus-ring)] ring-offset-2 ring-offset-[var(--surface-1)]'
                    : ''
                }`}
                style={{ backgroundColor: `var(--cat-${option.value})` }}
              />
            ))}
          </div>
        </div>

        <div>
          <Field label="图标" hint="按英文名搜索，如 coffee、house">
            <div className="relative">
              <MagnifyingGlass
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-[var(--text-tertiary)]"
              />
              <Input
                value={query}
                placeholder="搜索图标"
                className="pl-8"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          </Field>
          {icons.length === 0 ? (
            <p className="py-6 text-center text-sm text-[var(--text-secondary)]">
              没有匹配的图标
            </p>
          ) : (
            <div className="mt-2 grid max-h-56 grid-cols-8 gap-1 overflow-y-auto rounded-md ring-1 ring-[var(--border-subtle)] p-2">
              {icons.map((name) => (
                <button
                  key={name}
                  type="button"
                  title={name}
                  aria-label={name}
                  aria-pressed={icon === name}
                  onClick={() => setIcon(name)}
                  className={`flex size-8 items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-hover)] ${
                    icon === name ? 'bg-[var(--brand-soft)] ring-1 ring-[var(--brand)]' : ''
                  }`}
                >
                  <CategoryIcon icon={name} color={color} size={20} />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
