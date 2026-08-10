# Lottie 素材

运行时使用的自定义 Lottie JSON 本地托管，禁止外链：

- `celebrate.json` —— 里程碑庆祝动效（对账清零），一次性播放。5s，播完回调。

`empty-wallet.json` 只保留作历史素材，空状态现在统一使用低干扰的静态图标。

`raw/` 放的是改色前的原始文件，只作存档，代码不引用。来源与改色说明见 `raw/sources.txt`：
两个素材都是用户下载后**程序化改色成 阿贝设计 token** 的，颜色由素材自带，播放时不做覆盖。
改 JSON 颜色请重跑改色，别在代码里叠滤镜。

## 怎么接

播放器是 `src/components/abei/LottieArt.tsx`，素材地址从本目录的 `index.ts` 取：

```tsx
import { lottieArt } from '../../assets/lottie'
import { LottieArt } from '../../components/abei/LottieArt'

<LottieArt src={lottieArt.celebrate} className="size-28" fallback={<SomeIcon />} />
```

一次性播放的场景给 `loop={false}` 加 `onComplete`，参考 `CelebrateOverlay.tsx`。

## 几条约束

- **`index.ts` 里的 JSON 用 `?url` 导入**，拿到的是构建产物里的一个独立 asset 路径，JSON 不进 JS 包，
  只有真的要播时播放器才去 fetch。别改成 `import data from './x.json'`。
- **播放器走动态 import**（`LottieArt` 内部），压缩后约 165KB，必须留在独立 chunk 里，
  不能进主包——空状态不是首屏必现的东西。
- **用的是 `lottie-web/build/player/lottie_light`，不是完整版**。完整版靠直接 `eval` 跑 Lottie
  表达式，而 `nginx.conf` 的 CSP 是 `script-src 'self'`（没有 `unsafe-eval`），那句 eval 在生产
  会抛错把动画搞挂。light 版不带表达式引擎，只带 svg renderer，顺带小一半。
  以后要加带表达式的素材，先确认表达式对观感是不是必需，别直接换回完整版。
- **容器尺寸必须由 `className` 给死**，lottie 渲染出的 svg 是容器的 100%，容器没尺寸就什么都看不见。
- **`prefers-reduced-motion` 下完全不播，连播放器 chunk 都不下载**，改渲染 `fallback`。
  理由：为了画一帧静止画面拉 250KB 播放器，对明确要求少动效的用户是纯浪费。
- **加载失败静默留空**：素材 404、JSON 坏了、播放器 chunk 拿不到，都退回 `fallback`，不抛错、不显示破图。
- 插画是装饰性的，整个容器 `aria-hidden`，信息由旁边的文案承载。

语义状态图标（成功/加载中/出错/收件箱）不在这里，那是 `LottieIcon.tsx`，纯 Phosphor 图标，不含 Lottie。
