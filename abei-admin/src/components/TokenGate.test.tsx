import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { TokenGate } from './TokenGate'
import { setStoredToken, TOKEN_STORAGE_KEY, UNAUTHORIZED_EVENT } from '../api/client'

/** 一块有本地状态的「正在编辑的东西」，用来验证 401 之后它还在。 */
function Draft() {
  const [value, setValue] = useState('')
  return (
    <label>
      规则条件
      <input value={value} onChange={(event) => setValue(event.target.value)} />
    </label>
  )
}

function renderGate(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <TokenGate>
        <Draft />
      </TokenGate>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
})

describe('TokenGate', () => {
  it('401 之后不卸载页面，编到一半的内容还在', async () => {
    setStoredToken('existing-token')
    const queryClient = new QueryClient()
    renderGate(queryClient)

    const input = screen.getByLabelText('规则条件')
    await userEvent.type(input, '发件人包含 cmb')
    expect(input).toHaveValue('发件人包含 cmb')

    act(() => {
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT))
    })

    // 令牌页出现了，但下面的应用没被卸载——这正是这次改动的全部意义。
    expect(screen.getByLabelText('设置 API 令牌')).toBeInTheDocument()
    expect(screen.getByLabelText('规则条件')).toHaveValue('发件人包含 cmb')
  })

  it('401 不清查询缓存', async () => {
    setStoredToken('existing-token')
    const queryClient = new QueryClient()
    queryClient.setQueryData(['mail-rules'], { data: [] })
    renderGate(queryClient)

    act(() => {
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT))
    })

    // 缓存里是数据，令牌过期跟它没关系；清掉只会让重新登录后整站重拉一遍。
    expect(queryClient.getQueryData(['mail-rules'])).toEqual({ data: [] })
  })

  it('保存新令牌后原地继续，编辑内容不丢', async () => {
    setStoredToken('existing-token')
    const queryClient = new QueryClient()
    renderGate(queryClient)

    await userEvent.type(screen.getByLabelText('规则条件'), '草稿')
    act(() => {
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT))
    })

    await userEvent.type(screen.getByPlaceholderText('粘贴个人访问令牌…'), 'fresh-token')
    await userEvent.click(screen.getByRole('button', { name: '保存并继续' }))

    expect(screen.queryByLabelText('设置 API 令牌')).not.toBeInTheDocument()
    expect(screen.getByLabelText('规则条件')).toHaveValue('草稿')
    expect(sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe('fresh-token')
  })

  it('进门时没令牌就先不挂应用，免得发一串注定 401 的请求', () => {
    const queryClient = new QueryClient()
    renderGate(queryClient)

    expect(screen.getByLabelText('设置 API 令牌')).toBeInTheDocument()
    expect(screen.queryByLabelText('规则条件')).not.toBeInTheDocument()
  })
})
