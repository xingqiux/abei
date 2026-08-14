import { clearStoredToken } from '../api/client'

export const REQUEST_TOKEN_EVENT = 'granary:request-token'

export function requestTokenReset(): void {
  clearStoredToken()
  window.dispatchEvent(new CustomEvent(REQUEST_TOKEN_EVENT))
}
