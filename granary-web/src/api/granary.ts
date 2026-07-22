import { FireflyApiError, FireflyAuthError, UNAUTHORIZED_EVENT } from './client'

const CSRF_STORAGE_KEY = 'granary.csrf'
const BOOK_STORAGE_KEY = 'granary.book-id'

let sessionGeneration = 0
let sessionAbortController = new AbortController()

export interface InstanceInfo {
  initialized: boolean
  registration_mode: 'invite_only' | 'open'
  version: number
  service_version: string
}

export interface GranaryUser {
  id: number
  email: string
  display_name: string
  instance_admin: boolean
}

export interface GranaryBook {
  id: number
  organization_id: number
  name: string
  base_currency_code: string
  timezone: string
  role: 'manager' | 'editor' | 'viewer'
  version: number
  archived_at: string | null
}

export interface LoginResult {
  user_id: number
  display_name: string
  csrf_token: string | null
  mfa_required: boolean
  mfa_challenge_token: string | null
}

export interface MfaLoginResult {
  user_id: number
  display_name: string
  csrf_token: string
  mfa_required: false
}

function rotateSession(): void {
  sessionGeneration += 1
  sessionAbortController.abort()
  sessionAbortController = new AbortController()
}

function csrfToken(): string {
  try {
    return sessionStorage.getItem(CSRF_STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

export function setCsrfToken(value: string): void {
  sessionStorage.setItem(CSRF_STORAGE_KEY, value)
}

export function clearGranarySession(): void {
  sessionStorage.removeItem(CSRF_STORAGE_KEY)
  sessionStorage.removeItem(BOOK_STORAGE_KEY)
  rotateSession()
}

export function getActiveBookId(): number {
  const raw = sessionStorage.getItem(BOOK_STORAGE_KEY)
  const id = raw == null ? Number.NaN : Number(raw)
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new FireflyApiError(409, '尚未选择账本')
  }
  return id
}

export function setActiveBookId(bookId: number): void {
  sessionStorage.setItem(BOOK_STORAGE_KEY, String(bookId))
  rotateSession()
}

function errorDetails(status: number, statusText: string, raw: string): string {
  try {
    const parsed = JSON.parse(raw) as {
      error?: { message?: string }
      message?: string
      errors?: Record<string, string[]>
    }
    if (parsed.error?.message) return parsed.error.message
    if (parsed.errors) return Object.values(parsed.errors).flat().join('；')
    if (parsed.message) return parsed.message
  } catch {
    // The plain response body is included below.
  }
  return `${status} ${statusText}: ${raw.slice(0, 300)}`
}

async function request<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  params?: Record<string, string | number | undefined>,
): Promise<T> {
  const identity = sessionGeneration
  const url = new URL(path, window.location.origin)
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (!['GET'].includes(method)) {
    const csrf = csrfToken()
    if (csrf) headers['X-CSRF-Token'] = csrf
  }

  const response = await fetch(url, {
    method,
    credentials: 'same-origin',
    signal: sessionAbortController.signal,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (identity !== sessionGeneration) throw new Error('登录身份已经变更')
  if (!response.ok) {
    const raw = await response.text().catch(() => '')
    const message = errorDetails(response.status, response.statusText, raw)
    if (response.status === 401) {
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT))
      throw new FireflyAuthError(message)
    }
    throw new FireflyApiError(response.status, message)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export function granaryGet<T>(
  path: string,
  params?: Record<string, string | number | undefined>,
): Promise<T> {
  return request('GET', path, undefined, params)
}

export function granaryPost<T>(path: string, body: unknown): Promise<T> {
  return request('POST', path, body)
}

export function granaryPut<T>(path: string, body: unknown): Promise<T> {
  return request('PUT', path, body)
}

export function granaryDelete(path: string, params?: Record<string, string | number>): Promise<void> {
  return request('DELETE', path, undefined, params)
}

export function getInstanceInfo(): Promise<InstanceInfo> {
  return granaryGet('/api/v1/instance')
}

export function bootstrapInstance(input: {
  email: string
  display_name: string
  password: string
}): Promise<void> {
  return granaryPost('/api/v1/auth/bootstrap', input)
}

export async function login(input: { email: string; password: string }): Promise<LoginResult> {
  const result = await granaryPost<LoginResult>('/api/v1/auth/login', input)
  if (result.csrf_token) setCsrfToken(result.csrf_token)
  return result
}

export async function verifyMfaLogin(input: {
  challenge_token: string
  code: string
}): Promise<MfaLoginResult> {
  const result = await granaryPost<MfaLoginResult>('/api/v1/auth/mfa/verify-login', input)
  setCsrfToken(result.csrf_token)
  return result
}

export function getCurrentUser(): Promise<GranaryUser> {
  return granaryGet('/api/v1/me')
}

export async function refreshCsrfToken(): Promise<void> {
  const result = await granaryGet<{ csrf_token: string }>('/api/v1/auth/csrf')
  setCsrfToken(result.csrf_token)
}

export function getBooks(): Promise<GranaryBook[]> {
  return granaryGet('/api/v1/books')
}

export async function logout(): Promise<void> {
  await granaryPost('/api/v1/auth/logout', {})
  clearGranarySession()
}
