import { timingSafeEqual } from 'node:crypto'
import { beforeAll, describe, expect, it, vi, afterEach } from 'vitest'
import { createSessionToken, requestHasValidSession, sessionCookie } from './_auth'
import { onRequestPost } from './api/session'
import { onRequestGet as mapTile } from './api/map-tile'
import { onRequest } from './_middleware'

beforeAll(() => {
  if (!('timingSafeEqual' in crypto.subtle)) Object.defineProperty(crypto.subtle, 'timingSafeEqual', {
    value: (a: ArrayBuffer, b: ArrayBuffer) => timingSafeEqual(Buffer.from(a), Buffer.from(b)),
  })
})
afterEach(() => vi.unstubAllGlobals())
function environment() {
  const values = new Map<string, string>()
  return { AUTH_EMAIL: 'test@example.com', AUTH_PASSWORD: 'test-password', AUTH_SESSION_SECRET: 'test-secret', TIANDITU_SERVER_KEY: 'test-map-key',
    WEATHER_KV: { get: async (key: string) => values.get(key) ?? null,
      put: async (key: string, value: string) => { values.set(key, value) }, delete: async (key: string) => { values.delete(key) } } } as unknown as Env
}
function post(env: Env, body: unknown) {
  return onRequestPost({ request: new Request('https://site.test/api/session', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '127.0.0.1' }, body: JSON.stringify(body) }), env } as Parameters<typeof onRequestPost>[0]) as Promise<Response>
}
describe('mini program private website access', () => {
  it('issues a signed session using the website password, accepts Bearer and keeps cookie login', async () => {
    const env = environment(), response = await post(env, { email: 'test@example.com', password: 'test-password' })
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toContain('no-store')
    const { token } = await response.json() as { token: string }
    expect(await requestHasValidSession(new Request('https://site.test/data/orbit-passes.json', { headers: { Authorization: `Bearer ${token}` } }), env)).toBe(true)
    expect(await requestHasValidSession(new Request('https://site.test/', { headers: { Cookie: sessionCookie(token) } }), env)).toBe(true)
    expect(await requestHasValidSession(new Request('https://site.test/api/weather', { headers: { Authorization: `Bearer ${token}x` } }), env)).toBe(false)
  })
  it('shares the website failure throttle and rejects malformed or oversized JSON', async () => {
    const env = environment()
    for (let i = 0; i < 5; i++) expect((await post(env, { email: 'test@example.com', password: 'wrong' })).status).toBe(401)
    const blocked = await post(env, { email: 'test@example.com', password: 'test-password' })
    expect(blocked.status).toBe(429); expect(blocked.headers.get('Retry-After')).toBe('900')
    expect((await post(environment(), { email: null, password: 'a' })).status).toBe(400)
    expect((await post(environment(), { email: 'a', password: 'x'.repeat(9000) })).status).toBe(413)
    const invalid = await onRequestPost({ request: new Request('https://site.test/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }), env } as Parameters<typeof onRequestPost>[0])
    expect(invalid.status).toBe(400)
  })
  it('protects weather, orbit and map routes; only POST session is public', async () => {
    const env = environment(), next = vi.fn(async () => new Response('protected'))
    for (const path of ['/api/weather?all=1', '/data/orbit-passes.json', '/api/map-tile?layer=vec&z=8&x=1&y=1', '/api/session']) {
      const response = await onRequest({ request: new Request(`https://site.test${path}`), env, next } as unknown as Parameters<typeof onRequest>[0])
      expect(response.status).toBe(401)
    }
    expect(next).not.toHaveBeenCalled()
    await onRequest({ request: new Request('https://site.test/api/session', { method: 'POST' }), env, next } as unknown as Parameters<typeof onRequest>[0])
    expect(next).toHaveBeenCalledOnce()
    const token = await createSessionToken('test@example.com', env.AUTH_SESSION_SECRET)
    const response = await onRequest({ request: new Request('https://site.test/data/orbit-passes.json', { headers: { Authorization: `Bearer ${token}` } }), env, next } as unknown as Parameters<typeof onRequest>[0])
    expect(await response.text()).toBe('protected'); expect(response.headers.get('Cache-Control')).toContain('private')
  })
})
describe('Tianditu tile route', () => {
  const run = (query: string) => mapTile({ request: new Request(`https://site.test/api/map-tile?${query}`), env: environment() } as Parameters<typeof mapTile>[0]) as Promise<Response>
  it('uses the website vec/cva WMTS service and does not return the key', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL) => new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), { headers: { 'Content-Type': 'application/octet-stream' } }))
    vi.stubGlobal('fetch', fetcher)
    for (const layer of ['vec', 'cva']) {
      const response = await run(`layer=${layer}&z=8&x=210&y=100`)
      expect(response.status).toBe(200); expect(response.headers.get('Content-Type')).toBe('image/png')
      const url = new URL(String(fetcher.mock.calls.at(-1)?.[0]))
      expect(url.hostname).toMatch(/^t[0-7]\.tianditu\.gov\.cn$/)
      expect(url.pathname).toBe(`/${layer}_w/wmts`); expect(url.searchParams.get('TILEMATRIXSET')).toBe('w')
      expect(response.headers.get('Location')).toBe(null)
    }
  })
  it('rejects arbitrary layers, missing coordinates, out of bounds and non-image upstream errors', async () => {
    const fetcher = vi.fn(async () => new Response('<error>invalid key</error>', { headers: { 'Content-Type': 'text/xml' } }))
    vi.stubGlobal('fetch', fetcher)
    for (const query of ['layer=http://evil&z=8&x=1&y=1', 'layer=vec&z=8&x=1', 'layer=vec&z=4&x=16&y=0', 'layer=vec&z=30&x=0&y=0']) expect((await run(query)).status).toBe(400)
    expect(fetcher).not.toHaveBeenCalled()
    expect((await run('layer=vec&z=8&x=1&y=1')).status).toBe(502)
  })
  it('reports upstream permission errors without exposing the configured key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 301012, msg: '权限类型错误 test-map-key' }, { status: 403 })))
    const response = await run('layer=vec&z=8&x=1&y=1')
    const body = await response.json() as { error: string }
    expect(response.status).toBe(502); expect(body.error).toContain('301012')
    expect(body.error).toContain('权限类型错误'); expect(body.error).not.toContain('test-map-key')
  })
})
