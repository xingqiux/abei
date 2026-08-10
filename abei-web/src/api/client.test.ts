import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearStoredToken,
  AbeiSessionChangedError,
  apiGet,
  setStoredToken,
} from './client'

afterEach(() => {
  clearStoredToken()
  vi.unstubAllGlobals()
})

describe('apiGet', () => {
  it('preserves field validation errors', async () => {
    setStoredToken('test-token')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ message: 'invalid', errors: { amount: ['Amount must be positive'] } }),
          { status: 422, statusText: 'Unprocessable Content' },
        ),
      ),
    )

    await expect(apiGet('/v1/transactions')).rejects.toMatchObject({
      status: 422,
      validationErrors: { amount: ['Amount must be positive'] },
    })
  })

  it('discards a response that belongs to a previous token', async () => {
    setStoredToken('user-a')
    let resolveResponse!: (response: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn().mockReturnValue(
        new Promise<Response>((resolve) => {
          resolveResponse = resolve
        }),
      ),
    )

    const pending = apiGet('/v1/accounts')
    setStoredToken('user-b')
    resolveResponse(new Response(JSON.stringify({ data: [] }), { status: 200 }))

    await expect(pending).rejects.toBeInstanceOf(AbeiSessionChangedError)
  })

  it('aborts in-flight requests when the token changes', async () => {
    setStoredToken('user-a')
    let signal: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url, init: RequestInit) => {
        signal = init.signal as AbortSignal
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal?.reason), { once: true })
        })
      }),
    )

    const pending = apiGet('/v1/accounts')
    setStoredToken('user-b')

    expect(signal?.aborted).toBe(true)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('does not broadcast an old token 401 into the new session', async () => {
    setStoredToken('user-a')
    let resolveResponse!: (response: Response) => void
    const unauthorized = vi.fn()
    window.addEventListener('granary:unauthorized', unauthorized)
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise<Response>((resolve) => { resolveResponse = resolve })))

    const pending = apiGet('/v1/accounts')
    setStoredToken('user-b')
    resolveResponse(new Response('{}', { status: 401 }))

    await expect(pending).rejects.toBeInstanceOf(AbeiSessionChangedError)
    expect(unauthorized).not.toHaveBeenCalled()
    window.removeEventListener('granary:unauthorized', unauthorized)
  })

  it('does not broadcast a 401 when the token changes while reading its body', async () => {
    setStoredToken('user-a')
    let releaseBody!: () => void
    let markBodyRead!: () => void
    const bodyRead = new Promise<void>((resolve) => { markBodyRead = resolve })
    const bodyReleased = new Promise<void>((resolve) => { releaseBody = resolve })
    const unauthorized = vi.fn()
    window.addEventListener('granary:unauthorized', unauthorized)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({
      async pull(controller) {
        markBodyRead()
        await bodyReleased
        controller.enqueue(new TextEncoder().encode('{"message":"expired"}'))
        controller.close()
      },
    }), { status: 401 })))

    const pending = apiGet('/v1/accounts')
    await bodyRead
    setStoredToken('user-b')
    releaseBody()

    await expect(pending).rejects.toBeInstanceOf(AbeiSessionChangedError)
    expect(unauthorized).not.toHaveBeenCalled()
    window.removeEventListener('granary:unauthorized', unauthorized)
  })

  it('does not return a successful response when the token changes while reading its body', async () => {
    setStoredToken('user-a')
    let releaseBody!: () => void
    let markBodyRead!: () => void
    const bodyRead = new Promise<void>((resolve) => { markBodyRead = resolve })
    const bodyReleased = new Promise<void>((resolve) => { releaseBody = resolve })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({
      async pull(controller) {
        markBodyRead()
        await bodyReleased
        controller.enqueue(new TextEncoder().encode('{"data":[{"id":"old-user-account"}]}'))
        controller.close()
      },
    }), { status: 200 })))

    const pending = apiGet('/v1/accounts')
    await bodyRead
    setStoredToken('user-b')
    releaseBody()

    await expect(pending).rejects.toBeInstanceOf(AbeiSessionChangedError)
  })

  it('parses an unquoted download filename', async () => {
    setStoredToken('test-token')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('a,b\n1,2', {
      headers: {
        'Content-Type': 'text/csv; charset=UTF-8',
        'Content-Disposition': 'attachment; filename=2026-07-20-transactions.csv',
      },
    })))

    const { apiDownload } = await import('./client')
    const result = await apiDownload('/v1/firefly/api/v1/data/export/transactions?type=csv')

    expect(result.filename).toBe('2026-07-20-transactions.csv')
    expect(result.blob.type).toBe('text/csv;charset=utf-8')
  })
})
