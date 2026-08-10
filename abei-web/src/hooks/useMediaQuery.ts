import { useEffect, useState } from 'react'

/**
 * 媒体查询钩子。用在「同一份内容在宽屏是侧栏面板、窄屏是弹层」这种场合——
 * 光靠 CSS 隐藏做不到，两边同时挂载会有两份焦点陷阱和两份表单状态。
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches,
  )

  useEffect(() => {
    if (typeof window === 'undefined') return
    const list = window.matchMedia(query)
    setMatches(list.matches)
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches)
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }, [query])

  return matches
}

/** Tailwind 的 xl 断点。右侧详情面板要有 320px 才不挤压列表 */
export const XL_UP = '(min-width: 1280px)'
