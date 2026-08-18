import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyMailRule, getMailRuleApplyStatus, rollbackMailRule } from './mail'
import { AbeiApiError, isEndpointMissing } from './client'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function mockFetch(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => vi.unstubAllGlobals())

describe('applyMailRule', () => {
  it('把范围和上限放请求体，写闸门放查询串', async () => {
    const run = {
      run_id: '31', state: 'running', scope: 'unclassified',
      total_scanned: 244, matched: 244, rerouted: 0, reparse_jobs: 0, failed: 0, error: null,
    }
    const fetchMock = mockFetch(jsonResponse({ data: run }, 202))

    const result = await applyMailRule('7', { scope: 'unclassified', limit: 500 })

    // 服务端只开任务就返回，拿到的是任务的初始状态，不是跑完的结果。
    expect(result).toEqual({ data: run })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/v1/mail-rules/7/apply')
    // 闸门走查询串，参数走 body——服务端就是这么分的，混了会 400。
    expect(url).toContain('confirm=true')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ scope: 'unclassified', limit: 500 })
  })

  it('服务端还没上线这个端点时抛的错能被认成「端点缺失」', async () => {
    mockFetch(jsonResponse({ title: '未找到' }, 404))

    const error = await applyMailRule('7', { scope: 'all' }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AbeiApiError)
    // 界面靠这个判断来显示「服务端尚未更新」而不是刷一条红色失败提示。
    expect(isEndpointMissing(error)).toBe(true)
  })

  it('真失败不会被当成端点缺失', async () => {
    mockFetch(jsonResponse({ title: '服务器错误' }, 500))

    const error = await applyMailRule('7', { scope: 'all' }).catch((caught: unknown) => caught)

    expect(isEndpointMissing(error)).toBe(false)
  })
})

describe('rollbackMailRule', () => {
  it('把目标版本号发过去，并带上确认闸门', async () => {
    const fetchMock = mockFetch(jsonResponse({ data: { id: '7', type: 'mail-rule' } }))

    await rollbackMailRule('7', 3)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/v1/mail-rules/7/rollback')
    expect(url).toContain('confirm=true')
    expect(JSON.parse(init.body as string)).toEqual({ target_version: 3 })
  })
})

describe('getMailRuleApplyStatus', () => {
  it('查这条规则最近一次批量重归类的进度', async () => {
    const run = {
      run_id: '31', state: 'succeeded', scope: 'all',
      total_scanned: 300, matched: 244, rerouted: 240, reparse_jobs: 12, failed: 4, error: null,
    }
    const fetchMock = mockFetch(jsonResponse({ data: run }))

    const result = await getMailRuleApplyStatus('7')

    expect(result.data.state).toBe('succeeded')
    expect(result.data.rerouted + result.data.failed).toBe(244)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined]
    expect(url).toContain('/v1/mail-rules/7/apply-status')
    expect(init?.method ?? 'GET').toBe('GET')
  })
})
