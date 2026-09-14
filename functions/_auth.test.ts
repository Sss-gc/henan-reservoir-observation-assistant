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

  it('verifies the configured PBKDF2 password hash', async () => {
    const salt = new TextEncoder().encode('0123456789abcdef')
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('correct-password'), 'PBKDF2', false, ['deriveBits'])
    const hash = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 }, key, 256)
    const encoded = (value: Uint8Array) => Buffer.from(value).toString('base64url')
    const stored = `pbkdf2_sha256$100000$${encoded(salt)}$${encoded(new Uint8Array(hash))}`
    expect(await verifyPassword('correct-password', stored)).toBe(true)
    expect(await verifyPassword('wrong-password', stored)).toBe(false)
  })

  it('sets a host-only secure cookie and rejects cross-origin form posts', () => {
    expect(sessionCookie('token')).toContain('__Host-hroa_session=token; Path=/; HttpOnly; Secure; SameSite=Lax')
    expect(isSameOriginFormPost(new Request('https://example.com/login', { method: 'POST', headers: { Origin: 'https://example.com' } }))).toBe(true)
    expect(isSameOriginFormPost(new Request('https://example.com/login', { method: 'POST', headers: { Origin: 'https://attacker.example' } }))).toBe(false)
  })
})
