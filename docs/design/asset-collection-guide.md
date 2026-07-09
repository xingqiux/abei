# Granary 资产搜集指南（给人执行的清单）

> 2026-07-09。配合 `ui-design-spec.md` v2.1 使用。
> **分工更新（07-09 晚）**：静态图标（Lucide）、四个基础微动效（成功/同步/错误/收件箱，
> 来自开源包 useAnimations）、背景噪点与光晕（feTurbulence 程序生成）、Lottie 改色——均由 AI 侧完成，
> 无需搜集。**人工只需挑 2 个 Lottie**：空状态钱箱 + 庆祝，下载 JSON 丢进
> `granary-web/src/assets/lottie/raw/` 并附 sources.txt（文件名+素材页 URL）。
> 手把手版攻略见 Artifact「Granary 素材搜集攻略」。以下为完整参考版。

## 1. Lottie 动效图标（6 个场景，宁缺毋滥）

**全局风格约束**：线性描边风（stroke 2px 左右）、单色或双色、无背景框、无卡通人物；
时长 0.5–2s；能在深藏青底 `#0A0F1C` 上看清。下载 **JSON（Lottie）格式**。
颜色不用挑——入库前统一用编辑器改成谷仓色（主线条 `#E8EBF2`，强调 `#FCA311`，
成功 `#45C08F`，错误 `#E5484D`）。

| # | 场景 | 用在哪 | 搜索词 | 挑选要点 |
|---|---|---|---|---|
| 1 | 成功打勾 | 入账成功 toast | success check / tick | 一次性播完不循环，带一圈扩散更好 |
| 2 | 同步加载 | 收件箱同步等待 | sync / refresh / loading | 可无缝循环，节奏慢（≥1.2s/圈） |
| 3 | 空状态·钱箱 | 无交易/无预算页 | wallet / money box / coin | 低频呼吸感循环，动作幅度小 |
| 4 | 错误 | 解析失败/请求失败 | error / warning cross | 一次性，克制，不要爆炸效果 |
| 5 | 空收件箱 | 账单收件箱空态 | inbox / mailbox / email | 同 3，安静 |
| 6 | 庆祝 | 对账清零/储蓄达成 | confetti / celebration | 一次性 ≤2s；将来配 matter.js 谷粒物理 |

**去哪找（按优先级）**：

1. **useanimations.com** — 开源微动效图标（loading/checkmark/error/mail 都有），
   GitHub 直接下载全套 JSON，MIT 式许可最干净，风格极简线性、天然贴我们的规范。
2. **lottiefiles.com/free-animations** — 搜索词见上表；注意筛"Free"，下载 Lottie JSON。
   许可为 Lottie Simple License（免费可商用免署名，但**不可原样再分发售卖**，自用没问题）。
3. **iconscout.com/animated-icons** — 量最大（335K+）+ 站内 Lottie Editor 直接改色，
   但需登录、免费层要署名；当 1/2 找不到合适的再来这里补。
4. 兜底：**lordicon.com/icons**（免费包 1600+，风格统一的线性动效图标，免费层需署名）。

**验收**：6 个 JSON 放到 `granary-web/src/assets/lottie/`，命名
`success.json / sync.json / empty-wallet.json / error.json / empty-inbox.json / celebrate.json`，
每个 ≤ 60KB（过大说明太复杂，换）。可先用 lottiefiles.com/preview 把 JSON 拖进去在深色底上预览。

## 2. 背景与质感（谷仓的"底"）

设计方向（写进规范的定案）：深藏青底**不是纯平的**，由三层构成，全部低调——

1. **底色**：`#0A0F1C`（token `--g-bg`）。
2. **谷物噪点层**：细颗粒 grain/noise，透明度 3–5%，尺寸 200–300px 平铺——
   "谷粒"质感是谷仓唯一允许的主题隐喻，绝不能高于 5% 存在感。
3. **琥珀光晕**：页面左上或右上**一处** radial 光晕，`#FCA311` 透明度 6–8%、半径 ~600px；
   浅色主题换成 `#D97E00` 4–5%。每页最多一处，列表/表格区域不覆盖。

**去哪拿（免登录直接下载/复制）**：

| 资源 | 站点 | 用途 |
|---|---|---|
| SVG 噪点生成器 | **fffuel.co/nnnoise** | 调好颗粒度直接下载 SVG，做 grain 层 |
| 颗粒渐变生成器 | **fffuel.co/gggrain** | 噪点+光晕一体的 SVG 背景，深色模式友好 |
| 波形/斑点/渐变 | **haikei.app** | 免登录导出 SVG/PNG；只取"低对比"预设 |
| 平铺几何纹理 | **heropatterns.com** | 纯 CSS/SVG 平铺纹理，透明度可调；备选 |
| CSS 渐变光晕 | 不用下载 | `radial-gradient(600px at 85% -10%, rgb(252 163 17/.07), transparent 70%)` 直接写 |

**验收**：`granary-web/src/assets/bg/` 下 `grain.svg`（平铺噪点）+ 可选 `glow.svg`；
在深色底上叠加后截图确认：正文对比度不受影响、表格区域干净。

## 3. 静态图标（不用搜集，直接定案）

**Lucide**（lucide.dev）npm 包 `lucide-react`，1px 级线性风格与 MiSans 协调；
侧栏 8 项 + 常用操作（编辑/克隆/删除/筛选/同步）都有现成图标。不混用第二套图标库。

## 4. 字体（已定案，构建脚本处理）

MiSans 400/500/600（hyperos.mi.com 官方下载或 npm `misans`）+ JetBrains Mono 400/600
（jetbrains.com/lp/mono 或 fontsource）。由 `scripts/subset-fonts.py` 子集化，不需要手工整理。

## 5. 许可检查表（每个资产入库前过一遍）

- [ ] 来源和许可记进 `granary-web/src/assets/CREDITS.md`（文件名 / 来源 URL / 许可 / 是否需署名）
- [ ] 需要署名的（IconScout 免费层、lordicon 免费层）：署名文案放进「设置 → 关于」页
- [ ] 单文件 ≤ 60KB（Lottie）/ ≤ 30KB（SVG 背景）
- [ ] 深色底 `#0A0F1C` 和浅色底 `#ECECEA` 上都预览过
- [ ] 颜色已改为谷仓 token 色（Lottie 用 lottiefiles editor 或 IconScout editor；SVG 直接改 fill/stroke）
