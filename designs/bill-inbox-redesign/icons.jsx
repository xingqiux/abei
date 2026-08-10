/* 平台标记 + 界面图标。
   平台标记用各家真实的品牌 svg —— 见 brand.jsx，路径是从 Iconify 的公开图标集
   （simple-icons / Remix Icon / arcticons / logos）抓下来的，不是手画的抽象形。
   扫一列流水时，靠认得出的 logo 分辨来源比抽象几何快得多。
   每个标记 = 一块该品牌色调出来的圆角底 + 品牌图形；品牌色在 brand.jsx 里，
   深色主题用同一条目的 colorDark。 */

const PLATFORMS = Object.fromEntries(
  Object.entries(window.BRAND).map(([k, b]) => [k, { label: b.label, brand: b }]),
)
/* 认不出来源时的兜底：信封，不冒充任何一家。 */
PLATFORMS.other = { label: '其他', brand: null }

/** 平台标：品牌色底块 + 品牌图形。size 决定占位。 */
function PlatformMark({ kind = "other", size = 20, title }) {
  const meta = PLATFORMS[kind] || PLATFORMS.other
  const b = meta.brand
  /* 云闪付这类横向的字标，按正方形缩会缩成一团，让它占满底块的宽度。 */
  const vb = b ? b.vb.split(' ').map(Number) : null
  const wide = vb ? vb[2] / vb[3] > 1.4 : false
  const inner = Math.round(size * (!b ? 0.72 : wide ? 0.94 : 0.62))
  return (
    <span
      className="pmark"
      data-kind={kind}
      title={title === undefined ? meta.label : title}
      style={{
        "--pf": b ? b.color : "var(--text-tertiary)",
        "--pf-dark": b ? b.colorDark : "var(--text-tertiary)",
        color: "var(--pf-use)",
        width: size, height: size, flex: "none",
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        borderRadius: Math.round(size * 0.3),
        background: "color-mix(in oklab, var(--pf-use) calc(var(--pf-tint) * 100%), transparent)",
      }}
    >
      {b ? (
        <svg viewBox={b.vb} width={inner} height={wide ? Math.round(inner / (vb[2] / vb[3])) : inner} aria-hidden="true"
          style={{ display: "block", overflow: "visible" }}
          dangerouslySetInnerHTML={{ __html: b.body }} />
      ) : (
        <svg viewBox="0 0 20 20" width={inner} height={inner} aria-hidden="true"
          fill="none" stroke="currentColor" strokeWidth="1.6"
          strokeLinecap="round" strokeLinejoin="round" style={{ display: "block" }}>
          <rect x="3.8" y="5.6" width="12.4" height="8.8" rx="1.6" />
          <path d="M4.4 7l5.6 3.8L15.6 7" />
        </svg>
      )}
      <span className="sr-only">{meta.label}</span>
    </span>
  )
}

/** 渠道段、渠道 chip、邮件批次这类容器的上色变量，和平台标共用一支品牌色。 */
function pfVars(kind) {
  const b = (PLATFORMS[kind] || PLATFORMS.other).brand
  return {
    "--pf": b ? b.color : "var(--text-tertiary)",
    "--pf-dark": b ? b.colorDark : "var(--text-tertiary)",
  }
}

/* ── 界面图标：统一 16px 线性，1.6 描边 ──────────────────── */

function Ico({ d, size = 16, fill = false, children }) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} aria-hidden="true"
      style={{ display: 'block', flex: 'none' }}
      fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'}
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {children || <path d={d} />}
    </svg>
  )
}

const IconCaret = (p) => <Ico {...p} d="M7.8 4.5l5.4 5.5-5.4 5.5" />
const IconChevLeft = (p) => <Ico {...p} d="M12.2 4.5L6.8 10l5.4 5.5" />
const IconSync = (p) => (
  <Ico {...p}>
    <path d="M16.2 8.2A6.4 6.4 0 004.6 6.4" />
    <path d="M3.8 11.8a6.4 6.4 0 0011.6 1.8" />
    <path d="M4.4 3.6v2.9h2.9M15.6 16.4v-2.9h-2.9" />
  </Ico>
)
const IconGear = (p) => (
  <Ico {...p}>
    <circle cx="10" cy="10" r="2.4" />
    <path d="M10 3.2l.9 1.9 2.1-.4.5 2.1 1.9.9-1.1 1.8 1.1 1.8-1.9.9-.5 2.1-2.1-.4-.9 1.9-.9-1.9-2.1.4-.5-2.1-1.9-.9L4.7 10 3.6 8.2l1.9-.9.5-2.1 2.1.4z" />
  </Ico>
)
const IconSparkle = (p) => (
  <Ico {...p}>
    <path d="M10 3.4l1.5 3.9 3.9 1.5-3.9 1.5L10 14.2 8.5 10.3 4.6 8.8l3.9-1.5z" />
    <path d="M15.4 13.4l.7 1.7 1.7.7-1.7.7-.7 1.7-.7-1.7-1.7-.7 1.7-.7z" />
  </Ico>
)
const IconPanel = (p) => (
  <Ico {...p}>
    <rect x="3.2" y="4.2" width="13.6" height="11.6" rx="2" />
    <path d="M8.2 4.2v11.6" />
  </Ico>
)
const IconCheck = (p) => <Ico {...p} d="M4.6 10.4l3.5 3.5 7.3-8" />
const IconX = (p) => <Ico {...p} d="M5.4 5.4l9.2 9.2M14.6 5.4l-9.2 9.2" />
const IconLock = (p) => (
  <Ico {...p}>
    <rect x="4.6" y="8.8" width="10.8" height="7.2" rx="2" />
    <path d="M7.2 8.8V7a2.8 2.8 0 015.6 0v1.8" />
  </Ico>
)
const IconAlert = (p) => (
  <Ico {...p}>
    <path d="M10 4.2l6.2 11H3.8z" />
    <path d="M10 8.4v3M10 13.6v.1" />
  </Ico>
)
const IconInbox = (p) => (
  <Ico {...p}>
    <path d="M3.4 11.4h3.4l1 2h4.4l1-2h3.4" />
    <path d="M4.6 4.6h10.8l1.4 6.8v3a1.4 1.4 0 01-1.4 1.4H4.6a1.4 1.4 0 01-1.4-1.4v-3z" />
  </Ico>
)
const IconSearch = (p) => (
  <Ico {...p}>
    <circle cx="9" cy="9" r="4.8" />
    <path d="M12.6 12.6l3.6 3.6" />
  </Ico>
)
const IconSlider = (p) => (
  <Ico {...p}>
    <path d="M3.6 6.4h12.8M3.6 13.6h12.8" />
    <circle cx="8" cy="6.4" r="1.8" />
    <circle cx="13" cy="13.6" r="1.8" />
  </Ico>
)
const IconSplit = (p) => (
  <Ico {...p}>
    <path d="M4 5h4.5l3 5 3 5H16" />
    <path d="M4 15h4.5l1.6-2.7" />
    <path d="M13.6 3.4L16 5l-2.4 1.6M13.6 13.4L16 15l-2.4 1.6" />
  </Ico>
)

Object.assign(window, {
  PLATFORMS, PlatformMark, pfVars,
  IconCaret, IconChevLeft, IconSync, IconGear, IconSparkle, IconPanel,
  IconCheck, IconX, IconLock, IconAlert, IconInbox, IconSearch, IconSlider, IconSplit,
})
