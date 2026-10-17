import { describe, expect, it } from 'vitest'
import worker, { createSession } from './index.js'

const settings = { OBSERVER_ACCESS_CODE: 'test-only-independent-access-123456',
  OBSERVER_SESSION_SECRET: 'test-only-session-key-with-at-least-32-bytes' }
function environment() {
  const accesses: string[] = []
  return { ...settings, accesses, ASSETS: { async fetch(request: Request) {
    accesses.push(new URL(request.url).pathname)
    return new Response(new URL(request.url).pathname.endsWith('.docx') ? new Uint8Array([80, 75, 3, 4]) : '{"pipeline":"miniprogram-static-independent-v1"}')
  } } }
}
function request(path: string, token?: string, method = 'GET', data?: unknown) {
  return new Request('https://private.example.test' + path, { method,
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json' },
    ...(data ? { body: JSON.stringify(data) } : {}) })
}

describe('private static service authentication', () => {
  it('rejects direct JSON, Word, unknown paths, HEAD and query-token requests before reading assets', async () => {
    const env = environment()
    for (const path of ['/data/orbits.json', '/data/weather.json', '/data/manifest.json', '/documents/all.docx', '/documents/HN_RSV_001.docx', '/index.html', '/data/orbits.json?token=anything']) {
      for (const method of ['GET', 'HEAD']) expect((await worker.fetch(request(path, undefined, method), env)).status).toBe(401)
    }
    expect(env.accesses).toEqual([])
    const config = await import('node:fs/promises').then((fs) => fs.readFile('mini-static/wrangler.jsonc', 'utf8'))
    expect(JSON.parse(config).assets.run_worker_first).toBe(true)
    expect(JSON.parse(config).preview_urls).toBe(false)
  })
  it('only issues sessions after the independent code is verified; never returns the code', async () => {
    const env = environment()
    const bad = await worker.fetch(request('/api/session', undefined, 'POST', { accessCode: 'wrong' }), env)
    expect(bad.status).toBe(401)
    const good = await worker.fetch(request('/api/session', undefined, 'POST', { accessCode: settings.OBSERVER_ACCESS_CODE }), env)
    expect(good.status).toBe(200)
    const body = await good.json() as any
    expect(JSON.stringify(body)).not.toContain(settings.OBSERVER_ACCESS_CODE)
    for (const path of ['/data/orbits.json', '/data/weather.json', '/documents/all.docx', '/documents/HN_RSV_025.docx']) {
      const response = await worker.fetch(request(path, body.data.token), env)
      expect(response.status).toBe(200)
      expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    }
    expect(env.accesses).toHaveLength(4)
  })
  it('rejects forged, expired and rotated credentials; no access if server secrets are missing', async () => {
    const env = environment()
    const active = await createSession(env)
    const expired = await createSession(env, Date.now() - 31 * 86400000)
    for (const token of [expired.token, active.token + 'invalid', active.token.split('.')[0] + '.forged']) {
      expect((await worker.fetch(request('/data/orbits.json', token), env)).status).toBe(401)
    }
    env.OBSERVER_ACCESS_CODE += '-rotated'
    expect((await worker.fetch(request('/data/orbits.json', active.token), env)).status).toBe(401)
    env.OBSERVER_SESSION_SECRET = ''
    expect((await worker.fetch(request('/documents/all.docx', active.token), env)).status).toBe(503)
    expect(env.accesses).toEqual([])
  })
  it('only serves known static file paths after authentication; no website or refresh proxy', async () => {
    const env = environment()
    const session = await createSession(env)
    for (const path of ['/public/data/orbit-passes.json', '/api/weather', '/refresh', '/.dev.vars', '/documents/unknown.docx']) {
      expect((await worker.fetch(request(path, session.token), env)).status).toBe(404)
    }
    expect((await worker.fetch(request('/data/orbits.json', session.token, 'POST', { uid: 'forged' }), env)).status).toBe(405)
    expect(env.accesses).toEqual([])
  })
})
