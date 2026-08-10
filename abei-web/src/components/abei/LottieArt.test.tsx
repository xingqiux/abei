import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LottieArt } from './LottieArt'

const listeners = new Map<string, () => void>()
const destroy = vi.fn()
const loadAnimation = vi.fn(() => ({
  destroy,
  addEventListener: (name: string, cb: () => void) => listeners.set(name, cb),
}))

vi.mock('lottie-web/build/player/lottie_light', () => ({
  default: { loadAnimation: () => loadAnimation() },
}))

function setReducedMotion(reduce: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: reduce }),
  })
}

describe('LottieArt', () => {
  beforeEach(() => {
    listeners.clear()
    destroy.mockClear()
    loadAnimation.mockClear()
    setReducedMotion(false)
  })

  it('reduced-motion 下不加载播放器，渲染 fallback 并立刻收场', async () => {
    setReducedMotion(true)
    const onComplete = vi.fn()
    render(<LottieArt src="/a.json" fallback={<span>静态替身</span>} onComplete={onComplete} />)

    expect(screen.getByText('静态替身')).toBeInTheDocument()
    expect(onComplete).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(loadAnimation).not.toHaveBeenCalled())
  })

  it('正常路径加载播放器，卸载时销毁实例', async () => {
    const { unmount } = render(<LottieArt src="/a.json" />)
    await waitFor(() => expect(loadAnimation).toHaveBeenCalledTimes(1))
    unmount()
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('素材加载失败时静默退回 fallback 并收场', async () => {
    const onComplete = vi.fn()
    render(<LottieArt src="/missing.json" fallback={<span>静态替身</span>} onComplete={onComplete} />)
    await waitFor(() => expect(listeners.has('data_failed')).toBe(true))

    act(() => listeners.get('data_failed')?.())
    expect(screen.getByText('静态替身')).toBeInTheDocument()
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('loop=false 播完一遍触发 onComplete，且只触发一次', async () => {
    const onComplete = vi.fn()
    render(<LottieArt src="/a.json" loop={false} onComplete={onComplete} />)
    await waitFor(() => expect(listeners.has('complete')).toBe(true))

    act(() => {
      listeners.get('complete')?.()
      listeners.get('complete')?.()
    })
    expect(onComplete).toHaveBeenCalledTimes(1)
  })
})
