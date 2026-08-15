/**
 * 阿贝主标志：海獭捧着一枚扇贝，从下缘探出来。
 *
 * 两个版本，按底色选：
 * - `outline`（默认）奶油填充 + 夜海粗描边，浅底深底都成立。两个前端都有暗色模式、
 *   底色会翻，所以页面里一律用它。
 * - `solid` 纯奶油剪影，只在确定是夜海深底时用（描边在深底上是白费的）。
 *
 * 颜色写死，不跟 currentColor——形象只有这一种配色，调用处不用再传 text-* 着色类。
 * 24px 及以下自动换简化稿：胡须、贝壳沟纹和眼里的高光在那个尺寸只会糊成脏点。
 *
 * favicon 和应用图标是第三种形态（徽章式：固定夜海圆角底），不走这个组件，
 * 见 public/favicon.svg 与 docs/design/brand/abei-appicon.svg。
 */
const CREAM = '#EBDFC6'
const SHELL = '#F3EBDA'
const NIGHT = '#14262C'
/** 剪影版用的奶油，比描边版略深一档，深底上不刺眼。 */
const CREAM_SOLID = '#E4D5B8'

/**
 * 头 + 肩胸 + 耳朵。描边版共用。
 * 胸的路径底部伸到 y=132，越出 viewBox 是故意的——靠画幅裁掉底边那道描边，
 * 读作「从下缘探出来」。改回 128 底下会多一条横线。
 */
function OutlineBody({ stroke }: { stroke: number }) {
  return (
    <>
      <path
        d="M35,132 C33,104 40,76 60,76 C80,76 87,104 85,132 Z"
        fill={CREAM}
        stroke={NIGHT}
        strokeWidth={stroke}
        strokeLinejoin="round"
      />
      <circle cx="19" cy="42" r="8.5" fill={CREAM} stroke={NIGHT} strokeWidth={stroke} />
      <circle cx="101" cy="42" r="8.5" fill={CREAM} stroke={NIGHT} strokeWidth={stroke} />
      <path
        d="M60,24 C85,24 102,36 103,52 C104,67 89,80 60,80 C31,80 16,67 17,52 C18,36 35,24 60,24 Z"
        fill={CREAM}
        stroke={NIGHT}
        strokeWidth={stroke}
        strokeLinejoin="round"
      />
    </>
  )
}

function OutlineShell({ stroke }: { stroke: number }) {
  return (
    <path
      d="M40,112 Q37.5,107 41.5,101.5 Q41.5,95 48,93 Q51.5,88 60,88 Q68.5,88 72,93 Q78.5,95 78.5,101.5 Q82.5,107 80,112 Q71,116.5 60,116.5 Q49,116.5 40,112 Z"
      fill={SHELL}
      stroke={NIGHT}
      strokeWidth={stroke}
      strokeLinejoin="round"
    />
  )
}

function OutlineHands({ stroke }: { stroke: number }) {
  return (
    <>
      <circle cx="43" cy="95" r="8" fill={CREAM} stroke={NIGHT} strokeWidth={stroke} />
      <circle cx="77" cy="95" r="8" fill={CREAM} stroke={NIGHT} strokeWidth={stroke} />
    </>
  )
}

function OutlineArt() {
  return (
    <>
      <OutlineBody stroke={5} />
      <circle cx="41" cy="47" r="5" fill={NIGHT} />
      <circle cx="79" cy="47" r="5" fill={NIGHT} />
      <circle cx="42.8" cy="45.2" r="1.7" fill="#FFF" />
      <circle cx="80.8" cy="45.2" r="1.7" fill="#FFF" />
      <path
        d="M51,52 C51,48.8 69,48.8 69,52 C69,58.5 63.5,62.5 60,62.5 C56.5,62.5 51,58.5 51,52 Z"
        fill={NIGHT}
      />
      <path
        d="M60,62.5 L60,66.5 M60,66.5 C56.5,70.5 51.5,70.5 49.5,67.5 M60,66.5 C63.5,70.5 68.5,70.5 70.5,67.5"
        stroke={NIGHT}
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
      />
      <path
        d="M34,55 L21,52 M34,60 L21,62 M86,55 L99,52 M86,60 L99,62"
        stroke={NIGHT}
        strokeWidth="3"
        strokeLinecap="round"
      />
      <OutlineShell stroke={5} />
      <path
        d="M52,110 L49.5,98 M60,111 L60,94 M68,110 L70.5,98"
        stroke={NIGHT}
        strokeWidth="2.6"
        fill="none"
        strokeLinecap="round"
      />
      <OutlineHands stroke={5} />
    </>
  )
}

/** 描边·简化：去胡须、贝壳沟纹、眼高光，眼放大、描边加粗。 */
function OutlineArtSimple() {
  return (
    <>
      <OutlineBody stroke={6} />
      <circle cx="41" cy="47" r="6" fill={NIGHT} />
      <circle cx="79" cy="47" r="6" fill={NIGHT} />
      <path d="M50,51 C50,47.5 70,47.5 70,51 C70,58 64,63 60,63 C56,63 50,58 50,51 Z" fill={NIGHT} />
      <OutlineShell stroke={6} />
      <OutlineHands stroke={6} />
    </>
  )
}

/** 剪影版共用的头 + 肩胸。 */
function SolidBody() {
  return (
    <>
      <path d="M36,128 C34,104 40,74 60,74 C80,74 86,104 84,128 Z" />
      <path d="M60,26 C84,26 100,37 101,52 C102,66 88,78 60,78 C32,78 18,66 19,52 C20,37 36,26 60,26 Z" />
    </>
  )
}

function SolidArt() {
  return (
    <>
      <g fill={CREAM_SOLID}>
        <circle cx="20" cy="43" r="6.2" />
        <circle cx="100" cy="43" r="6.2" />
        <SolidBody />
        <path
          d="M44,110 Q42,106 45.5,101.5 Q45.5,96.5 51,95 Q54,91 60,91 Q66,91 69,95 Q74.5,96.5 74.5,101.5 Q78,106 76,110 Q69,113.5 60,113.5 Q51,113.5 44,110 Z"
          stroke={NIGHT}
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <circle cx="45" cy="95" r="6.3" stroke={NIGHT} strokeWidth="2" />
        <circle cx="75" cy="95" r="6.3" stroke={NIGHT} strokeWidth="2" />
      </g>
      <g fill={NIGHT}>
        <circle cx="41" cy="46.5" r="4" />
        <circle cx="79" cy="46.5" r="4" />
        <path d="M52,53 C52,50 68,50 68,53 C68,59 63,62.5 60,62.5 C57,62.5 52,59 52,53 Z" />
      </g>
      <path
        d="M60,62.5 L60,66 M60,66 C57,69.5 52.5,69.5 50.5,67 M60,66 C63,69.5 67.5,69.5 69.5,67"
        stroke={NIGHT}
        strokeWidth="2.2"
        fill="none"
        strokeLinecap="round"
      />
      <path
        d="M36,58 L26,56 M36,62 L25,63 M84,58 L94,56 M84,62 L95,63"
        stroke={NIGHT}
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M53,108 L51.5,100 M60,109 L60,97.5 M67,108 L68.5,100"
        stroke={NIGHT}
        strokeWidth="1.6"
        fill="none"
        strokeLinecap="round"
      />
    </>
  )
}

function SolidArtSimple() {
  return (
    <>
      <g fill={CREAM_SOLID}>
        <circle cx="18" cy="44" r="8" />
        <circle cx="102" cy="44" r="8" />
        <SolidBody />
        <path
          d="M42,108 Q40,103 44,98 Q45,90 52,88 Q55,84.5 60,84.5 Q65,84.5 68,88 Q75,90 76,98 Q80,103 78,108 Q69,112 60,112 Q51,112 42,108 Z"
          stroke={NIGHT}
          strokeWidth="3"
          strokeLinejoin="round"
        />
      </g>
      <g fill={NIGHT}>
        <circle cx="41" cy="46" r="5.5" />
        <circle cx="79" cy="46" r="5.5" />
        <path d="M50,55 C50,51.5 70,51.5 70,55 C70,62 64,66 60,66 C56,66 50,62 50,55 Z" />
      </g>
    </>
  )
}

export function AbeiMark({
  size = 24,
  variant = 'outline',
  className = '',
}: {
  /** 渲染高度（px）。别再用 size-* 类，尺寸由这里决定，简化稿也按它自动切换。 */
  size?: number
  /** 底色拿不准就用默认的 outline；确定是夜海深底才用 solid。 */
  variant?: 'outline' | 'solid'
  className?: string
}) {
  const small = size <= 24
  return (
    <svg
      width={(size * 120) / 128}
      height={size}
      viewBox="0 0 120 128"
      fill="none"
      aria-hidden
      className={className}
    >
      {variant === 'solid' ? (
        small ? (
          <SolidArtSimple />
        ) : (
          <SolidArt />
        )
      ) : small ? (
        <OutlineArtSimple />
      ) : (
        <OutlineArt />
      )}
    </svg>
  )
}
