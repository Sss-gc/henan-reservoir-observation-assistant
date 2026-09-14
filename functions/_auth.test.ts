import { timingSafeEqual } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  createSessionToken, isSameOriginFormPost, sessionCookie, verifyPassword, verifySessionToken,
} from './_auth'

beforeAll(() => {
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: typeof timingSafeEqual }
  if (!subtle.timingSafeEqual) {
    Object.defineProperty(subtle, 'timingSafeEqual', {
      value: (left: ArrayBuffer | ArrayBufferView, right: ArrayBuffer | ArrayBufferView) =>
        timingSafeEqual(Buffer.from(left instanceof ArrayBuffer ? left : left.buffer), Buffer.from(right instanceof ArrayBuffer ? right : right.buffer)),
    })
  }
})

describe('Pages authentication primitives', () => {
  it('accepts a valid signed session and rejects tampering or expiry', async () => {
    const now = Date.UTC(2026, 8, 14)
    const token = await createSessionToken('306221976@qq.com', 'test-session-secret', now)
    expect(await verifySessionToken(token, '306221976@qq.com', 'test-session-secret', now + 1_000)).toBe(true)
    expect(await verifySessionToken(`${token}x`, '306221976@qq.com', 'test-session-secret', now + 1_000)).toBe(false)
    expect(await verifySessionToken(token, 'other@example.com', 'test-session-secret', now + 1_000)).toBe(false)
    expect(await verifySessionToken(token, '306221976@qq.com', 'test-session-secret', now + 31 * 24 * 60 * 60 * 1_000)).toBe(false)
  })

  it('compares the configured password through fixed-size digests', async () => {
    expect(await verifyPassword('correct-password', 'correct-password')).toBe(true)
    expect(await verifyPassword('wrong-password', 'correct-password')).toBe(false)
  })

  it('sets a host-only secure cookie and rejects cross-origin form posts', () => {
    expect(sessionCookie('token')).toContain('__Host-hroa_session=token; Path=/; HttpOnly; Secure; SameSite=Lax')
    expect(isSameOriginFormPost(new Request('https://example.com/login', { method: 'POST', headers: { Origin: 'https://example.com' } }))).toBe(true)
    expect(isSameOriginFormPost(new Request('https://example.com/login', { method: 'POST', headers: { Origin: 'https://attacker.example' } }))).toBe(false)
    expect(isSameOriginFormPost(new Request('https://example.com/login', { method: 'POST', headers: { Origin: 'null', 'Sec-Fetch-Site': 'same-origin' } }))).toBe(true)
    expect(isSameOriginFormPost(new Request('https://example.com/login', { method: 'POST', headers: { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' } }))).toBe(false)
  })
})
