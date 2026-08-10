/**
 * Phosphor 图标（跟生产版 @phosphor-icons/react 同源，MIT）→ icons.jsx。
 * 重跑：node gen-icons.mjs
 */
import fs from 'node:fs'

const NAMES = [
  'sun', 'tray', 'arrows-left-right', 'sparkle', 'wallet', 'money', 'tag', 'chart-bar', 'gear',
  'magnifying-glass', 'calendar-blank', 'plus', 'caret-right', 'caret-left', 'caret-down',
  'lock-simple', 'user-circle', 'funnel', 'x', 'check', 'warning-circle', 'clock-counter-clockwise',
  'arrow-right', 'dots-three', 'pencil-simple', 'trash', 'arrow-down', 'arrow-up', 'receipt',
  'scales', 'repeat', 'question', 'list-bullets', 'squares-four', 'rows', 'eye',
]

const res = await fetch(`https://api.iconify.design/ph.json?icons=${NAMES.join(',')}`)
const json = await res.json()

const camel = (n) => n.replace(/-(.)/g, (_, c) => c.toUpperCase())
const entries = []
for (const name of NAMES) {
  const icon = json.icons[name]
  if (!icon) throw new Error(`missing icon: ${name}`)
  const w = icon.width ?? json.width ?? 256
  const h = icon.height ?? json.height ?? 256
  entries.push(`  ${camel(name)}: { vb: '0 0 ${w} ${h}', body: ${JSON.stringify(icon.body)} },`)
}

const body = `/* 本文件由 gen-icons.mjs 生成，勿手改。图标来自 Phosphor（MIT），跟生产版同一套。 */

const ICONS = {
${entries.join('\n')}
}

/** 单色图标。size 直接给像素，颜色跟随 currentColor。 */
function Ic({ name, size = 16, style }) {
  const icon = ICONS[name]
  if (!icon) return null
  return (
    <svg
      viewBox={icon.vb}
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', flex: 'none', ...style }}
      dangerouslySetInnerHTML={{ __html: icon.body }}
    />
  )
}

Object.assign(window, { ICONS, Ic })
`
fs.writeFileSync(new URL('./icons.jsx', import.meta.url), body)
console.log('icons.jsx', body.length, 'bytes ·', NAMES.length, '个图标')
