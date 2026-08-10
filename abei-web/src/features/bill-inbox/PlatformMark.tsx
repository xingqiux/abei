import { BRAND_MARKS, platformLabel, type PlatformKey } from './brandMarks'

/**
 * 一枚平台标：品牌色调出来的圆角底 + 该平台自己的 logo。
 *
 * 主区每行左端和渠道 chip 上都用它。扫一列流水时，来源靠这个认，
 * 描述里就不用再重复印一遍「支付宝-」前缀了。
 *
 * 深浅两支品牌色由 index.css 的 `.platform-mark` 规则挑（主题有三态，JS 读不准）。
 */
export function PlatformMark({
  platform,
  size = 20,
  /** 传空串把 title / 读屏文字关掉：chip 上平台名就在旁边，再念一遍是噪音 */
  title,
}: {
  platform: PlatformKey
  size?: number
  title?: string
}) {
  const mark = platform === 'other' ? null : BRAND_MARKS[platform]
  const label = title === undefined ? platformLabel(platform) : title

  // 云闪付那种横向字标按正方形缩会缩成一团，让它占满底块的宽度
  const [, , vbW, vbH] = mark ? mark.viewBox.split(' ').map(Number) : [0, 0, 1, 1]
  const ratio = vbW / vbH
  const wide = mark != null && ratio > 1.4
  const inner = Math.round(size * (mark == null ? 0.72 : wide ? 0.94 : 0.62))

  return (
    <span
      className="platform-mark inline-flex shrink-0 items-center justify-center"
      title={label || undefined}
      style={{
        '--pf': mark ? mark.color : 'var(--text-tertiary)',
        '--pf-dark': mark ? mark.colorDark : 'var(--text-tertiary)',
        color: 'var(--pf-use)',
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        background: 'color-mix(in oklab, var(--pf-use) 11%, transparent)',
      } as React.CSSProperties}
    >
      {mark ? (
        <svg
          viewBox={mark.viewBox}
          width={inner}
          height={wide ? Math.round(inner / ratio) : inner}
          aria-hidden
          className="block"
          dangerouslySetInnerHTML={{ __html: mark.path }}
        />
      ) : (
        // 认不出来源：信封兜底，不冒充任何一家
        <svg
          viewBox="0 0 20 20"
          width={inner}
          height={inner}
          aria-hidden
          className="block"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3.8" y="5.6" width="12.4" height="8.8" rx="1.6" />
          <path d="M4.4 7l5.6 3.8L15.6 7" />
        </svg>
      )}
      {label && <span className="sr-only">{label}</span>}
    </span>
  )
}
