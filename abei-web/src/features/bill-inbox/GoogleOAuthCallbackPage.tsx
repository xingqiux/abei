import { useEffect, useRef, useState } from 'react'
import { SpinnerGap, WarningCircle } from '@phosphor-icons/react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { completeGoogleMailboxOAuth } from '../../api/firefly'
import { AbeiApiError } from '../../api/client'
import { Button } from '../../components/ui/Button'
import { showToast } from '../../store/toastStore'

export function GoogleOAuthCallbackPage() {
  const { code, state, error, errorDescription } = useSearch({
    from: '/oauth/google/callback',
  })
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const submitted = useRef(false)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    if (submitted.current) return
    submitted.current = true
    if (error) {
      setFailure(error === 'access_denied' ? 'Google 授权已取消' : (errorDescription ?? error))
      return
    }
    if (!code || !state) {
      setFailure('Google OAuth 回调缺少 code 或 state')
      return
    }

    void completeGoogleMailboxOAuth({ code, state })
      .then((settings) => {
        queryClient.setQueryData(['bill-inbox-settings'], settings)
        showToast({ kind: 'success', message: `Google 邮箱 ${settings.data.attributes.email} 已连接` })
        return navigate({ to: '/bill-inbox', search: {}, replace: true })
      })
      .catch((cause: unknown) => {
        setFailure(cause instanceof AbeiApiError ? cause.message : 'Google 邮箱连接失败')
      })
  }, [code, error, errorDescription, navigate, queryClient, state])

  return (
    <div className="mx-auto flex min-h-72 max-w-md flex-col items-center justify-center gap-4 text-center">
      {failure ? (
        <>
          <WarningCircle aria-hidden className="size-8 text-[var(--danger)]" weight="fill" />
          <div>
            <h1 className="text-base font-semibold text-[var(--text-primary)]">Google 邮箱连接失败</h1>
            <p className="mt-1 text-sm text-[var(--text-secondary)]">{failure}</p>
          </div>
          <Button variant="secondary" size="md" onClick={() => void navigate({ to: '/bill-inbox', search: {} })}>
            返回账单收件箱
          </Button>
        </>
      ) : (
        <>
          <SpinnerGap aria-hidden className="size-8 animate-spin text-[var(--brand-text)]" />
          <div role="status">
            <h1 className="text-base font-semibold text-[var(--text-primary)]">正在连接 Google 邮箱</h1>
            <p className="mt-1 text-sm text-[var(--text-secondary)]">正在确认授权…</p>
          </div>
        </>
      )}
    </div>
  )
}
