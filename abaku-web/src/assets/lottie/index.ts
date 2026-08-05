import celebrateUrl from './celebrate.json?url'
import emptyWalletUrl from './empty-wallet.json?url'

/**
 * Lottie 素材的 URL 表。用 `?url` 导入：构建时 JSON 被单独产出成一个 asset 文件，
 * 这里拿到的只是一串路径，JSON 本身不会被打进 JS bundle，只在真正播放时才由播放器去取。
 * 千万别改成 `import data from './x.json'`——那样 66KB 的 JSON 会直接进包。
 */
export const lottieArt = {
  celebrate: celebrateUrl,
  'empty-wallet': emptyWalletUrl,
} as const

export type LottieArtName = keyof typeof lottieArt
