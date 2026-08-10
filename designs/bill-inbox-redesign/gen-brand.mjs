import fs from 'node:fs'

/* 各平台 → 用哪个公开图标集里的品牌 svg，配什么品牌色。
   浅色主题用 color，深色主题用 colorDark（调亮，否则招行的深红在暗底上糊掉）。 */
const SPEC = {
  alipay:   { icon: 'simple-icons:alipay',            color: '#1677FF', dark: '#5B9DFF', label: '支付宝' },
  wechat:   { icon: 'simple-icons:wechat',            color: '#07C160', dark: '#3EDC8A', label: '微信支付' },
  tenpay:   { icon: 'ri:wechat-pay-fill',             color: '#07C160', dark: '#3EDC8A', label: '财付通' },
  cmb:      { icon: 'arcticons:china-merchants-bank', color: '#C7000B', dark: '#FF6A63', label: '招商银行' },
  boc:      { icon: 'arcticons:boc',                  color: '#A4231F', dark: '#FF7C6E', label: '中国银行' },
  douyin:   { icon: 'simple-icons:tiktok',            color: '#161823', dark: '#E9EAF0', label: '抖音支付' },
  unionpay: { icon: 'logos:unionpay',                 color: '#E21836', dark: '#FF6B7E', label: '云闪付' },
  huabei:   { icon: 'ri:alipay-fill',                 color: '#FF6A00', dark: '#FF9A4D', label: '花呗' },
  pdd:      { icon: 'arcticons:pinduoduo',            color: '#E02E24', dark: '#FF7A6E', label: '拼多多' },
  jd:       { icon: 'arcticons:jd-com',               color: '#E1251B', dark: '#FF7468', label: '京东' },
  meituan:  { icon: 'simple-icons:meituan',           color: '#C79000', dark: '#FFD100', label: '美团' },
  apple:    { icon: 'simple-icons:icloud',            color: '#4B5563', dark: '#C6CBD4', label: 'Apple / iCloud' },
}

const byPrefix = {}
for (const s of Object.values(SPEC)) {
  const [p, n] = s.icon.split(':')
  ;(byPrefix[p] ||= new Set()).add(n)
}

const store = {}
for (const [p, names] of Object.entries(byPrefix)) {
  const r = await fetch(`https://api.iconify.design/${p}.json?icons=${[...names].join(',')}`)
  const j = await r.json()
  for (const [n, ic] of Object.entries(j.icons || {})) {
    store[`${p}:${n}`] = { w: ic.width ?? j.width ?? 24, h: ic.height ?? j.height ?? 24, body: ic.body }
  }
}

const entries = []
for (const [k, s] of Object.entries(SPEC)) {
  const ic = store[s.icon]
  if (!ic) { console.error('MISSING ' + s.icon); continue }
  entries.push([
    `  ${k}: {`,
    `    label: ${JSON.stringify(s.label)},`,
    `    source: ${JSON.stringify(s.icon)},`,
    `    color: ${JSON.stringify(s.color)},`,
    `    colorDark: ${JSON.stringify(s.dark)},`,
    `    vb: "0 0 ${ic.w} ${ic.h}",`,
    `    body: ${JSON.stringify(ic.body)},`,
    `  },`,
  ].join('\n'))
}

const header = [
  '/* 各平台的品牌标记 —— 路径是从 Iconify 的公开图标集抓下来的，不是手画的抽象形。',
  '   来源集：simple-icons（CC0）、Remix Icon（Apache-2.0）、arcticons（CC BY-SA）、logos。',
  '   图标文件本身可自由使用，但商标归各平台所有，这里只作「这笔流水来自谁」的识别。',
  '   重新生成：node gen-brand.mjs（脚本见 设计说明.md 末尾）。 */',
  '',
  'window.BRAND = {',
].join('\n')

fs.writeFileSync(process.argv[2], header + '\n' + entries.join('\n') + '\n}\n')
console.log('wrote', process.argv[2], entries.length, 'marks')
