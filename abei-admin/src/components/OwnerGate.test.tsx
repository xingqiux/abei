import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { OwnerGate } from './OwnerGate'
import * as feedbackApi from '../api/feedback'

function renderGate() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <OwnerGate>
        <p>后台内容</p>
      </OwnerGate>
    </QueryClientProvider>,
  )
}

function session(isOwner: boolean): feedbackApi.SessionResponse {
  return { data: { user_id: 1, actor: 'lichangle', role: 'owner', is_owner: isOwner } }
}

describe('OwnerGate', () => {
  it('owner 能看到后台内容', async () => {
    vi.spyOn(feedbackApi, 'getSession').mockResolvedValue(session(true))
    renderGate()
    expect(await screen.findByText('后台内容')).toBeInTheDocument()
  })

  it('非 owner 看到的是解释，而不是一屏 403', async () => {
    vi.spyOn(feedbackApi, 'getSession').mockResolvedValue(session(false))
    renderGate()
    expect(await screen.findByText('这里只有管理员能进')).toBeInTheDocument()
    expect(screen.queryByText('后台内容')).not.toBeInTheDocument()
  })

  it('会话查不动时给重试，不当成没权限', async () => {
    vi.spyOn(feedbackApi, 'getSession').mockRejectedValue(new Error('boom'))
    renderGate()
    expect(await screen.findByText('无法确认管理权限')).toBeInTheDocument()
    // 「没权限」和「查不出来」是两件事，说错了会让人去改 Firefly 的用户角色。
    expect(screen.queryByText('这里只有管理员能进')).not.toBeInTheDocument()
  })
})
