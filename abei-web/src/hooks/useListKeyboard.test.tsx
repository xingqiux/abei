import { fireEvent, render, renderHook, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useListKeyboard } from './useListKeyboard'

interface Row {
  id: string
}

const rowsOf = (...ids: string[]): Row[] => ids.map((id) => ({ id }))

const mocks = {
  onActivate: vi.fn(),
  onAction: vi.fn(),
}

beforeEach(() => {
  mocks.onActivate.mockReset()
  mocks.onAction.mockReset()
})

/** 键盘层挂在 window 上，从 body 派发即可冒泡到监听器（target 不是输入控件）。 */
function press(key: string, init: KeyboardEventInit = {}) {
  fireEvent.keyDown(document.body, { key, ...init })
}

function setup(rows: Row[], enabled = true) {
  return renderHook(
    ({ rows: r, enabled: e }: { rows: Row[]; enabled: boolean }) =>
      useListKeyboard<Row>({ rows: r, onActivate: mocks.onActivate, onAction: mocks.onAction, enabled: e }),
    { initialProps: { rows, enabled } },
  )
}

describe('useListKeyboard 光标移动', () => {
  it('↓ 逐行下移，到最后一行停住而不环绕', () => {
    const { result } = setup(rowsOf('a', 'b', 'c'))

    expect(result.current.cursor).toBe(0)
    press('ArrowDown')
    expect(result.current.cursor).toBe(1)
    press('ArrowDown')
    expect(result.current.cursor).toBe(2)
    press('ArrowDown')
    press('ArrowDown')
    expect(result.current.cursor).toBe(2)

    press('Enter')
    expect(mocks.onActivate).toHaveBeenCalledTimes(1)
    expect(mocks.onActivate).toHaveBeenCalledWith({ id: 'c' })
  })

  it('↑ 逐行上移，到第一行停住而不环绕', () => {
    const { result } = setup(rowsOf('a', 'b', 'c'))

    press('ArrowDown')
    press('ArrowDown')
    expect(result.current.cursor).toBe(2)
    press('ArrowUp')
    expect(result.current.cursor).toBe(1)
    press('ArrowUp')
    press('ArrowUp')
    press('ArrowUp')
    expect(result.current.cursor).toBe(0)

    press('Enter')
    expect(mocks.onActivate).toHaveBeenCalledWith({ id: 'a' })
  })

  it('空列表下按键既不回调也不越界', () => {
    const { result } = setup([])

    press('ArrowDown')
    press('Enter')
    press('c')

    expect(result.current.cursor).toBe(0)
    expect(mocks.onActivate).not.toHaveBeenCalled()
    expect(mocks.onAction).not.toHaveBeenCalled()
  })
})

describe('useListKeyboard 回调', () => {
  it('Enter 把光标所在行交给 onActivate', () => {
    setup(rowsOf('a', 'b', 'c'))

    press('ArrowDown')
    press('Enter')

    expect(mocks.onActivate).toHaveBeenCalledTimes(1)
    expect(mocks.onActivate).toHaveBeenCalledWith({ id: 'b' })
    expect(mocks.onAction).not.toHaveBeenCalled()
  })

  it.each(['c', 'e', 'x'] as const)('动作键 %s 带着键位和当前行调用 onAction', (key) => {
    setup(rowsOf('a', 'b', 'c'))

    press('ArrowDown')
    press('ArrowDown')
    press(key)

    expect(mocks.onAction).toHaveBeenCalledTimes(1)
    expect(mocks.onAction).toHaveBeenCalledWith(key, { id: 'c' })
    expect(mocks.onActivate).not.toHaveBeenCalled()
  })

  it('不认识的键既不回调也不移动光标', () => {
    const { result } = setup(rowsOf('a', 'b'))

    press('k')
    press('ArrowRight')

    expect(result.current.cursor).toBe(0)
    expect(mocks.onAction).not.toHaveBeenCalled()
    expect(mocks.onActivate).not.toHaveBeenCalled()
  })

  it('空格等于 x：勾选当前行，手不用离开走位键', () => {
    const { result } = setup(rowsOf('a', 'b', 'c'))

    press('ArrowDown')
    press(' ')

    expect(result.current.cursor).toBe(1)
    expect(mocks.onAction).toHaveBeenCalledTimes(1)
    expect(mocks.onAction).toHaveBeenCalledWith('x', { id: 'b' })
    expect(mocks.onActivate).not.toHaveBeenCalled()
  })

  it('带 Ctrl/Cmd/Alt 修饰键时让位给浏览器快捷键（Cmd+C 必须还是复制）', () => {
    const { result } = setup(rowsOf('a', 'b', 'c'))

    press('c', { ctrlKey: true })
    press('c', { metaKey: true })
    press('e', { altKey: true })
    press('ArrowDown', { metaKey: true })

    expect(mocks.onAction).not.toHaveBeenCalled()
    expect(result.current.cursor).toBe(0)
  })
})

describe('useListKeyboard 输入控件里不接管按键', () => {
  // 稳定引用：rows 换引用会触发光标复位，真实调用方也都用 useMemo 传
  const stableRows = rowsOf('a', 'b', 'c')

  function Harness() {
    const { cursor } = useListKeyboard<Row>({
      rows: stableRows,
      onActivate: mocks.onActivate,
      onAction: mocks.onAction,
    })
    return (
      <div>
        <span data-testid="cursor">{cursor}</span>
        <input aria-label="搜索" />
        <textarea aria-label="备注" />
        <div aria-label="富文本" data-testid="rich" />
      </div>
    )
  }

  it.each([
    ['input', '搜索'],
    ['textarea', '备注'],
  ])('焦点在 %s 里时 ↓/Enter/动作键全部放行给输入', (_tag, label) => {
    render(<Harness />)
    const field = screen.getByLabelText(label)

    fireEvent.keyDown(field, { key: 'ArrowDown' })
    fireEvent.keyDown(field, { key: 'Enter' })
    fireEvent.keyDown(field, { key: 'c' })
    fireEvent.keyDown(field, { key: 'x' })

    expect(screen.getByTestId('cursor')).toHaveTextContent('0')
    expect(mocks.onActivate).not.toHaveBeenCalled()
    expect(mocks.onAction).not.toHaveBeenCalled()
  })

  it('焦点在 contenteditable 元素里时同样不接管', () => {
    render(<Harness />)
    const rich = screen.getByTestId('rich')
    // jsdom 不实现 isContentEditable（永远是 undefined），这里补上浏览器的真实取值
    Object.defineProperty(rich, 'isContentEditable', { configurable: true, value: true })

    fireEvent.keyDown(rich, { key: 'ArrowDown' })
    fireEvent.keyDown(rich, { key: 'Enter' })
    fireEvent.keyDown(rich, { key: 'e' })

    expect(screen.getByTestId('cursor')).toHaveTextContent('0')
    expect(mocks.onActivate).not.toHaveBeenCalled()
    expect(mocks.onAction).not.toHaveBeenCalled()
  })

  it('同一个元素不再可编辑后又重新接管按键', () => {
    render(<Harness />)
    const rich = screen.getByTestId('rich')
    Object.defineProperty(rich, 'isContentEditable', { configurable: true, value: false })

    fireEvent.keyDown(rich, { key: 'ArrowDown' })

    expect(screen.getByTestId('cursor')).toHaveTextContent('1')
  })
})

describe('useListKeyboard 列表变化与开关', () => {
  it('翻页换掉数据后光标复位，不会停在越界的旧位置', () => {
    const { result, rerender } = setup(rowsOf('a', 'b', 'c', 'd', 'e'))

    press('ArrowDown')
    press('ArrowDown')
    press('ArrowDown')
    expect(result.current.cursor).toBe(3)

    rerender({ rows: rowsOf('x', 'y'), enabled: true })
    expect(result.current.cursor).toBe(0)

    press('Enter')
    expect(mocks.onActivate).toHaveBeenCalledTimes(1)
    expect(mocks.onActivate).toHaveBeenCalledWith({ id: 'x' })

    press('ArrowDown')
    press('ArrowDown')
    expect(result.current.cursor).toBe(1)
  })

  it('enabled 为 false 时完全不响应键盘', () => {
    const { result } = setup(rowsOf('a', 'b', 'c'), false)

    press('ArrowDown')
    press('Enter')
    press('c')

    expect(result.current.cursor).toBe(0)
    expect(mocks.onActivate).not.toHaveBeenCalled()
    expect(mocks.onAction).not.toHaveBeenCalled()
  })

  it('从 enabled=false 切回 true 后重新接管键盘', () => {
    const { result, rerender } = setup(rowsOf('a', 'b', 'c'), false)

    press('ArrowDown')
    expect(result.current.cursor).toBe(0)

    rerender({ rows: rowsOf('a', 'b', 'c'), enabled: true })
    press('ArrowDown')
    expect(result.current.cursor).toBe(1)
  })

  it('卸载后不再监听 window 上的按键', () => {
    const { result, unmount } = setup(rowsOf('a', 'b', 'c'))

    press('ArrowDown')
    expect(result.current.cursor).toBe(1)

    unmount()
    press('ArrowDown')
    press('Enter')

    expect(mocks.onActivate).not.toHaveBeenCalled()
  })
})
