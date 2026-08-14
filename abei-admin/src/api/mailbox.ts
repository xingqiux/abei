/**
 * 同步器（收件邮箱）的配置面。
 *
 * 前台 abei-web 里这几个端点混在 api/firefly.ts + api/queries.ts 那两千多行的账本
 * 数据层里，后台只用得上这五个调用，所以在这边单独立一份，而不是把整个数据层搬过来。
 * 两边同时改的可能性很低——真要改的是服务端的响应形状，这份 schema 跟着服务端走。
 */
import { z } from 'zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiDelete, apiGet, apiPost, apiPut } from './client'

export const mailboxSettingsSchema = z.object({
  data: z.object({
    type: z.string(),
    attributes: z.object({
      enabled: z.boolean(),
      provider: z.enum(['gmail', 'imap']),
      auth_method: z.enum(['google_oauth', 'password']),
      email: z.string(),
      host: z.string(),
      port: z.number(),
      encryption: z.enum(['none', 'ssl', 'tls', 'starttls']),
      username: z.string(),
      folder: z.string(),
      has_password: z.boolean(),
      google_connected: z.boolean(),
      google_oauth_available: z.boolean(),
      built_in_channels: z.array(z.unknown()).optional(),
    }),
  }),
})

export const googleOAuthStartSchema = z.object({
  data: z.object({
    type: z.literal('google-oauth'),
    attributes: z.object({ authorization_url: z.url() }),
  }),
})

export type MailboxSettings = z.infer<typeof mailboxSettingsSchema>
export type GoogleOAuthStart = z.infer<typeof googleOAuthStartSchema>

/** 服务端不回明文密码，所以密码是只写字段，不在返回形状里。 */
export type MailboxSettingsInput = Partial<
  Pick<
    MailboxSettings['data']['attributes'],
    'enabled' | 'provider' | 'email' | 'host' | 'port' | 'encryption' | 'username' | 'folder'
  >
> & { password?: string }

export async function getMailboxSettings(): Promise<MailboxSettings> {
  return mailboxSettingsSchema.parse(await apiGet('/v1/bills/mailbox'))
}

export async function updateMailboxSettings(input: MailboxSettingsInput): Promise<MailboxSettings> {
  return mailboxSettingsSchema.parse(await apiPut('/v1/bills/mailbox', input))
}

export async function startGoogleMailboxOAuth(): Promise<GoogleOAuthStart> {
  return googleOAuthStartSchema.parse(await apiPost('/v1/bills/mailbox/google/connect', {}))
}

export async function completeGoogleMailboxOAuth(input: {
  code: string
  state: string
}): Promise<MailboxSettings> {
  return mailboxSettingsSchema.parse(await apiPost('/v1/bills/mailbox/google/callback', input))
}

export async function disconnectGoogleMailbox(): Promise<MailboxSettings> {
  await apiDelete('/v1/bills/mailbox/google')
  return getMailboxSettings()
}

const SETTINGS_KEY = ['mailbox-settings'] as const

export function useMailboxSettings(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: getMailboxSettings,
    enabled: opts.enabled ?? true,
  })
}

export function useUpdateMailboxSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: MailboxSettingsInput) => updateMailboxSettings(input),
    onSuccess: (data) => queryClient.setQueryData(SETTINGS_KEY, data),
  })
}

export function useStartGoogleMailboxOAuth() {
  return useMutation({ mutationFn: startGoogleMailboxOAuth })
}

export function useDisconnectGoogleMailbox() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: disconnectGoogleMailbox,
    onSuccess: (data) => queryClient.setQueryData(SETTINGS_KEY, data),
  })
}
