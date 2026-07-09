# Lottie 自定义素材

内置微动效（打勾/加载/错误/信封）走 `react-useanimations`，代码里直接用，无需放文件在这里。

本目录用于**等待用户搜集**的两个自定义 Lottie JSON（见
`docs/design/asset-collection-guide.md` §2 的搜集规范：下载 JSON 本地托管，禁止运行时外链）：

- `empty-wallet.json` —— 空钱包/空列表插画，用于账户、预算等页面的空状态。
- `celebrate.json` —— 里程碑庆祝动效（对账清零、储蓄目标达成等一次性播放场景）。

## 接入方式

素材放好之后，用 `LottieIcon` 的 file 模式加载（`src/components/granary/LottieIcon.tsx`）：

```tsx
import emptyWalletUrl from '../../assets/lottie/empty-wallet.json?url'

<LottieIcon kind="file" src={emptyWalletUrl} size={64} loop />
```

`kind="file"` 时组件内部直接用 `lottie-web` 播放传入的 JSON（`react-useanimations` 只内置了它自己
那套动效，无法播放外部文件），颜色需要素材本身自带（file 模式不做 strokeColor 覆盖）。

在文件到位前，`kind="file"` 且 `src` 缺失/加载失败时组件静默留空，不会抛错。
