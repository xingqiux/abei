import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MoneyText } from '../components/abei/MoneyText'
import { usePrivacyStore } from './privacyStore'

afterEach(() => {
  usePrivacyStore.setState({ hidden: false })
})

const hide = () => act(() => usePrivacyStore.getState().toggle())

describe('privacyStore', () => {
  it('默认不隐藏，toggle 一次隐藏、再一次恢复', () => {
    expect(usePrivacyStore.getState().hidden).toBe(false)

    usePrivacyStore.getState().toggle()
    expect(usePrivacyStore.getState().hidden).toBe(true)

    usePrivacyStore.getState().toggle()
    expect(usePrivacyStore.getState().hidden).toBe(false)
  })
})

describe('MoneyText 正常模式', () => {
  it('按语义加正负号并格式化金额', () => {
    render(
      <>
        <MoneyText value="1234.5" semantic="expense" />
        <MoneyText value="1234.5" semantic="income" />
        <MoneyText value="1234.5" semantic="transfer" />
        <MoneyText value="1234.5" semantic="neutral" />
      </>,
    )

    expect(screen.getByText('-¥1,234.50')).toBeInTheDocument()
    expect(screen.getByText('+¥1,234.50')).toBeInTheDocument()
    expect(screen.getAllByText('¥1,234.50')).toHaveLength(2)
  })

  it('自定义币种符号，并把真值同时放进 aria-label 和 title', () => {
    render(<MoneyText value="88" semantic="expense" symbol="$" />)

    const el = screen.getByText('-$88.00')
    expect(el).toHaveAttribute('aria-label', '-$88.00')
    expect(el).toHaveAttribute('title', '-$88.00')
  })

  it('语义颜色走 CSS 变量类', () => {
    render(
      <>
        <MoneyText value="1" semantic="income" />
        <MoneyText value="2" semantic="transfer" />
        <MoneyText value="3" semantic="expense" />
      </>,
    )

    expect(screen.getByText('+¥1.00')).toHaveClass('text-[var(--income)]')
    expect(screen.getByText('¥2.00')).toHaveClass('text-[var(--transfer)]')
    expect(screen.getByText('-¥3.00')).toHaveClass('text-[var(--text-primary)]')
  })
})

describe('MoneyText 隐私模式', () => {
  it('隐藏时渲染 ••••，真值一个字符都不进 DOM', () => {
    const { container } = render(<MoneyText value="1234.5" semantic="expense" />)
    expect(screen.getByText('-¥1,234.50')).toBeInTheDocument()

    hide()

    expect(screen.getByText('••••')).toBeInTheDocument()
    expect(screen.queryByText('-¥1,234.50')).not.toBeInTheDocument()
    expect(container.innerHTML).not.toContain('1,234.50')
    expect(container.textContent).toBe('••••')
  })

  it('隐藏时页面上所有金额一起变，不用逐个订阅', () => {
    render(
      <>
        <MoneyText value="10" semantic="expense" />
        <MoneyText value="20" semantic="income" />
        <MoneyText value="30" semantic="transfer" />
      </>,
    )

    hide()

    expect(screen.getAllByText('••••')).toHaveLength(3)
  })

  it('隐藏时不给 title，读屏拿到的是「金额已隐藏」而不是真值', () => {
    render(<MoneyText value="1234.5" semantic="expense" />)

    hide()

    const el = screen.getByText('••••')
    // 现状记录：真值在隐藏后没有任何出口——aria-label 是固定文案，title 直接不给。
    // 存疑——组件自己的注释写的是「真值不进 DOM 文本，但留给读屏和复制用」，与这里的实现相反，见回报。
    expect(el).toHaveAttribute('aria-label', '金额已隐藏')
    expect(el).not.toHaveAttribute('title')
  })

  it('语义颜色在隐藏后仍然保留', () => {
    render(<MoneyText value="1234.5" semantic="income" />)

    hide()

    expect(screen.getByText('••••')).toHaveClass('text-[var(--income)]')
  })

  it('恢复后金额原样回来', () => {
    render(<MoneyText value="1234.5" semantic="expense" />)

    hide()
    expect(screen.getByText('••••')).toBeInTheDocument()

    hide()
    expect(screen.getByText('-¥1,234.50')).toBeInTheDocument()
    expect(screen.queryByText('••••')).not.toBeInTheDocument()
  })
})
