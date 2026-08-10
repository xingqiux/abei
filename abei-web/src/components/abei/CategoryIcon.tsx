import {
  AirplaneTilt,
  Airplane,
  AppWindow,
  Armchair,
  ArrowLineDown,
  ArrowsLeftRight,
  Bank,
  Barbell,
  Basket,
  Bicycle,
  BookOpen,
  BowlFood,
  Briefcase,
  Bus,
  Champagne,
  Chalkboard,
  ChargingStation,
  ChartLineUp,
  Coffee,
  Coins,
  Cookie,
  CreditCard,
  Crown,
  DotsThree,
  DotsThreeCircle,
  FilmSlate,
  FirstAid,
  ForkKnife,
  GameController,
  Gift,
  GraduationCap,
  Hammer,
  HandCoins,
  HandHeart,
  House,
  Key,
  Laptop,
  Lightning,
  Moped,
  MusicNotes,
  Percent,
  Pill,
  Question,
  Receipt,
  Scales,
  ShieldCheck,
  ShoppingBag,
  ShoppingCart,
  TShirt,
  Taxi,
  Tram,
  TrendUp,
  WifiHigh,
  Wrench,
  type Icon,
} from '@phosphor-icons/react'

/**
 * 分类图标。全站展示分类的唯一入口：交易行、分类管理、预算、图表图例都走这里。
 *
 * 后端存的是图标名（"ForkKnife"）和色板号（"1"~"12"），不存 hex——
 * 存了 hex 就没法跟着深浅主题走，也没法整体调色。这里把这两个字符串
 * 翻成一个 duotone 图标 + 一块圆角底色，其余地方不许自己拼。
 *
 * duotone 的第二层跟着分类色走，所以底色和图标本身是同一个色相，
 * 一排分类摆在一起时能一眼扫出「这几个是一类的」。
 */

/** 允许出现的图标名 → Phosphor 组件。名字对不上时退回 Question，不报错。 */
const ICONS: Record<string, Icon> = {
  // 收入
  Briefcase,
  HandCoins,
  TrendUp,
  Wrench,
  Coins,
  // 餐饮
  ForkKnife,
  BowlFood,
  Moped,
  Coffee,
  Cookie,
  Champagne,
  // 交通
  Bus,
  Tram,
  Taxi,
  Bicycle,
  AirplaneTilt,
  ChargingStation,
  // 居住
  House,
  Key,
  Lightning,
  Hammer,
  Armchair,
  // 通讯与订阅
  Receipt,
  WifiHigh,
  AppWindow,
  Crown,
  // 购物
  ShoppingCart,
  Basket,
  TShirt,
  Laptop,
  ShoppingBag,
  // 健康
  FirstAid,
  Pill,
  Barbell,
  // 娱乐与出行
  GameController,
  FilmSlate,
  Airplane,
  MusicNotes,
  // 教育
  GraduationCap,
  Chalkboard,
  BookOpen,
  // 人情
  Gift,
  HandHeart,
  // 金融
  Bank,
  Percent,
  Scales,
  ShieldCheck,
  // 资金往来与兜底
  DotsThreeCircle,
  DotsThree,
  ArrowsLeftRight,
  CreditCard,
  ArrowLineDown,
  ChartLineUp,
  Question,
}

export type CategoryIconSize = 16 | 20 | 24 | 48

/** 圆角底的边长和圆角，跟图标尺寸绑死，调用方不用管 */
const BOX: Record<CategoryIconSize, { box: number; radius: number }> = {
  16: { box: 24, radius: 6 },
  20: { box: 30, radius: 8 },
  24: { box: 36, radius: 10 },
  48: { box: 72, radius: 18 },
}

/** 名字里的连字符、下划线、大小写差异都当同一个图标，免得后端写法一变就全掉成问号 */
function lookup(icon: string | null | undefined): Icon {
  if (!icon) return Question
  const direct = ICONS[icon]
  if (direct) return direct
  const key = icon.replace(/[^a-z0-9]/gi, '').toLowerCase()
  for (const [name, Component] of Object.entries(ICONS)) {
    if (name.toLowerCase() === key) return Component
  }
  return Question
}

/** 色板号只认 "1"~"12"，其余（空、乱填、旧的 hex）一律落到 12 号灰 */
function paletteSlot(color: string | null | undefined): number {
  const n = Number(color)
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : 12
}

export function CategoryIcon({
  icon,
  color,
  size = 24,
  className = '',
}: {
  icon?: string | null
  color?: string | null
  size?: CategoryIconSize
  className?: string
}) {
  const Glyph = lookup(icon)
  const slot = paletteSlot(color)
  const { box, radius } = BOX[size]

  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center ${className}`}
      style={{
        width: box,
        height: box,
        borderRadius: radius,
        background: `var(--cat-${slot}-soft)`,
        color: `var(--cat-${slot})`,
      }}
    >
      <Glyph size={size} weight="duotone" />
    </span>
  )
}
