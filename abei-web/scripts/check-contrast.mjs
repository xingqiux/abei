#!/usr/bin/env node
/**
 * 从 src/index.css 里读 token，逐对算 WCAG 对比度。
 *
 * 为什么要有这个：配色是手挑的，AA 达标与否靠脑补必错。上一版就有
 * 「深色下 --brand 当文字用，对比度 3.5:1」这类问题一直没人发现。
 * 加一条命令就再也不用靠脑补。
 *
 * 只查会真的出现在屏幕上的组合，不做笛卡尔积——凑不出的组合报错没意义。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '..', 'src', 'index.css'), 'utf8')

/** 从某个选择器块里抓 `--name: value;`，顺带解析 var(--color-ink-*) 的一层引用 */
function tokensIn(blockRe) {
  const block = css.match(blockRe)
  if (!block) throw new Error(`index.css 里找不到区块：${blockRe}`)
  const out = {}
  for (const [, name, value] of block[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out[name] = value.trim()
  }
  return out
}

const palette = tokensIn(/@theme\s*\{([\s\S]*?)\n\}/)
const light = tokensIn(/:root,\s*\n:root\[data-theme='light'\]\s*\{([\s\S]*?)\n\}/)
const dark = tokensIn(/:root\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/)

function resolve(theme, name, depth = 0) {
  if (depth > 4) throw new Error(`token 引用套太深：${name}`)
  const raw = theme[name] ?? palette[name]
  if (raw == null) throw new Error(`token 未定义：${name}`)
  const ref = raw.match(/^var\((--[a-z0-9-]+)\)$/)
  if (ref) return resolve(theme, ref[1], depth + 1)
  if (!/^#[0-9a-f]{6}$/i.test(raw)) throw new Error(`${name} 不是六位色值，无法计算：${raw}`)
  return raw
}

/** 半透明 token（--cat-N-soft 这种 `rgb(r g b / a)`）压到某个底色上，算出实际显示的色 */
function flatten(theme, name, onHex) {
  const raw = theme[name] ?? palette[name]
  if (raw == null) throw new Error(`token 未定义：${name}`)
  const m = raw.match(/^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\d.]+)\s*\)$/)
  if (!m) throw new Error(`${name} 不是 rgb(r g b / a) 形式：${raw}`)
  const a = Number(m[4])
  const hex = (i) =>
    Math.round(Number(m[i]) * a + parseInt(onHex.slice(1 + (i - 1) * 2, 3 + (i - 1) * 2), 16) * (1 - a))
      .toString(16)
      .padStart(2, '0')
  return `#${hex(1)}${hex(2)}${hex(3)}`
}

function luminance(hex) {
  const channel = (v) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  const r = channel(parseInt(hex.slice(1, 3), 16))
  const g = channel(parseInt(hex.slice(3, 5), 16))
  const b = channel(parseInt(hex.slice(5, 7), 16))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** [前景, 背景, 最低要求]。4.5 = 正文 AA；3.0 = 大字号/图形边界 AA */
const PAIRS = [
  // 正文三级 × 页面底和卡片
  ['--text-primary', '--surface-0', 4.5],
  ['--text-primary', '--surface-1', 4.5],
  ['--text-primary', '--surface-2', 4.5],
  ['--text-secondary', '--surface-0', 4.5],
  ['--text-secondary', '--surface-1', 4.5],
  ['--text-secondary', '--surface-hover', 4.5],
  ['--text-tertiary', '--surface-0', 4.5],
  ['--text-tertiary', '--surface-1', 4.5],

  // 金额语义色：交易表里就长在卡片和 hover 行上
  ['--income', '--surface-0', 4.5],
  ['--income', '--surface-1', 4.5],
  ['--income', '--surface-hover', 4.5],
  ['--transfer', '--surface-0', 4.5],
  ['--transfer', '--surface-1', 4.5],
  ['--attention', '--surface-0', 4.5],
  ['--attention', '--surface-1', 4.5],
  ['--danger', '--surface-0', 4.5],
  ['--danger', '--surface-1', 4.5],
  ['--done', '--surface-0', 4.5],
  ['--done', '--surface-1', 4.5],
  // 负债余额：账户列表里就是一列数字，按正文算
  ['--liability', '--surface-0', 4.5],
  ['--liability', '--surface-1', 4.5],
  ['--liability', '--surface-hover', 4.5],

  // 语义 chip：深底浅字
  ['--income', '--income-soft', 4.5],
  ['--transfer', '--transfer-soft', 4.5],
  ['--attention', '--attention-soft', 4.5],
  ['--danger', '--danger-soft', 4.5],
  ['--done', '--done-soft', 4.5],

  // 品牌：底当按钮（配 --brand-on），--brand-text 当页面前景
  ['--brand-on', '--brand', 4.5],
  ['--brand-on', '--brand-hover', 4.5],
  ['--brand-text', '--surface-0', 4.5],
  ['--brand-text', '--surface-1', 4.5],
  ['--brand-text', '--brand-soft', 4.5],
  // 导航当前项：中性底 + 品牌色图标和文字
  ['--brand-text', '--surface-selected', 4.5],
  // 当前项左侧那根 3px 指示条是图形
  ['--brand', '--surface-selected', 3.0],
  ['--brand', '--surface-1', 3.0],

  // 中性徽章：侧栏 / 「我的」里的数字
  ['--text-secondary', '--surface-selected', 4.5],
  // 徽章右上角那颗 6px 危险圆点，图形
  ['--danger', '--surface-selected', 3.0],
  ['--danger', '--surface-1', 3.0],
  ['--attention-mark', '--surface-1', 3.0],

  // 描边和焦点环是图形，3:1 够
  ['--border-strong', '--surface-0', 3.0],
  ['--border-strong', '--surface-1', 3.0],
  ['--focus-ring', '--surface-0', 3.0],
  ['--focus-ring', '--surface-1', 3.0],

  // 图表色是色块和折线，按图形算 3:1。画在页面底和卡片上两种都有
  ...Array.from({ length: 6 }, (_, i) => [`--chart-${i + 1}`, '--surface-0', 3.0]),
  ...Array.from({ length: 6 }, (_, i) => [`--chart-${i + 1}`, '--surface-1', 3.0]),

  // 分类 12 色板：图标、色点、进度条，都是图形
  ...Array.from({ length: 12 }, (_, i) => [`--cat-${i + 1}`, '--surface-0', 3.0]),
  ...Array.from({ length: 12 }, (_, i) => [`--cat-${i + 1}`, '--surface-1', 3.0]),
]

let failed = 0
for (const [label, theme] of [['浅色', light], ['深色', dark]]) {
  console.log(`\n${label}`)
  for (const [fg, bg, min] of PAIRS) {
    const value = ratio(resolve(theme, fg), resolve(theme, bg))
    const ok = value >= min
    if (!ok) failed++
    console.log(
      `  ${ok ? '✓' : '✗'} ${fg} on ${bg}`.padEnd(52) +
        `${value.toFixed(2)}:1 (需 ${min.toFixed(1)})`,
    )
  }
}

// 深色下 surface-0/1/2 必须真的分得开。上一版只差 5 个点，屏幕上是一片糊的。
console.log('\n深色表面层级')
for (const [a, b] of [['--surface-0', '--surface-1'], ['--surface-1', '--surface-2']]) {
  const value = ratio(resolve(dark, a), resolve(dark, b))
  const ok = value >= 1.08
  if (!ok) failed++
  console.log(`  ${ok ? '✓' : '✗'} ${a} vs ${b}`.padEnd(52) + `${value.toFixed(3)}:1 (需 1.080)`)
}

// --cat-N-soft 是半透明的，压到卡片底上才知道图标在自己的底色上还看不看得清
for (const [label, theme] of [['浅色', light], ['深色', dark]]) {
  console.log(`\n${label} 分类图标：色 on 自己的 soft 底（压在 --surface-1 上）`)
  for (let i = 1; i <= 12; i++) {
    const bg = flatten(theme, `--cat-${i}-soft`, resolve(theme, '--surface-1'))
    const value = ratio(resolve(theme, `--cat-${i}`), bg)
    const ok = value >= 3.0
    if (!ok) failed++
    console.log(`  ${ok ? '✓' : '✗'} --cat-${i} on --cat-${i}-soft`.padEnd(52) + `${value.toFixed(2)}:1 (需 3.0)`)
  }
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项不达标`)
process.exit(failed === 0 ? 0 : 1)
