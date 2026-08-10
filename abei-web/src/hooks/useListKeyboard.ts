import { useEffect, useRef, useState } from 'react'

/**
 * 列表键盘层：↑↓ 移动、Enter 展开、C 改分类、E 编辑、X 或空格 选中。
 * 输入框/文本域/可编辑元素里不接管按键；翻页后光标复位到第一行。
 */
export function useListKeyboard<T>({ rows, onActivate, onAction, enabled = true }: {
  rows: T[]
  onActivate?: (row: T) => void
  onAction?: (key: 'c' | 'e' | 'x', row: T) => void
  enabled?: boolean
}) {
  const [cursor, setCursor] = useState(0)
  const rowsRef = useRef(rows)
  const cursorRef = useRef(cursor)
  rowsRef.current = rows
  cursorRef.current = cursor

  useEffect(() => {
    setCursor(0)
  }, [rows])

  useEffect(() => {
    if (!enabled) return
    function isEditableTarget(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false
      const tag = target.tagName.toLowerCase()
      return tag === 'input' || tag === 'textarea' || target.isContentEditable
    }
    function onKeyDown(e: KeyboardEvent) {
      if (isEditableTarget(e.target)) return
      // 带修饰键的组合让给浏览器/系统快捷键，否则 Cmd+C 会被当成「改分类」并吞掉复制
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const list = rowsRef.current
      const n = list.length
      if (n === 0) return
      let index = cursorRef.current
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setCursor(Math.min(index + 1, n - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setCursor(Math.max(index - 1, 0))
      } else if (e.key === 'Enter' && onActivate) {
        e.preventDefault()
        onActivate(list[index])
      } else if ((e.key === 'c' || e.key === 'e' || e.key === 'x') && onAction) {
        e.preventDefault()
        onAction(e.key, list[index])
      } else if (e.key === ' ' && onAction) {
        // 空格勾选：连着归几十笔分类时，手不用离开走位键去够 x
        e.preventDefault()
        onAction('x', list[index])
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled, onActivate, onAction])

  return { cursor, setCursor }
}
