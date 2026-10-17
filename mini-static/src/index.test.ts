import { describe, expect, it } from 'vitest'
import worker from './index.js'

function environment() {
  const accesses: string[] = []
  return { accesses, ASSETS: { async fetch(request: Request) {
    accesses.push(new URL(request.url).pathname)
    return new Response(request.method === 'HEAD' ? null : new URL(request.url).pathname.endsWith('.docx')
      ? new Uint8Array([80, 75, 3, 4]) : '{"pipeline":"miniprogram-static-independent-v1"}')
  } } }
}
const request = (path: string, method = 'GET') => new Request('https://static.example.test' + path, { method })
describe('login-free independent static service', () => {
  it('serves data and both Word scopes without credentials or server secrets', async () => {
    const env = environment()
    for (const path of ['/data/orbits.json', '/data/weather.json', '/data/manifest.json', '/documents/all.docx', '/documents/HN_RSV_025.docx']) {
      for (const method of ['GET', 'HEAD']) {
        const response = await worker.fetch(request(path, method), env)
        expect(response.status).toBe(200)
        expect(response.headers.get('Cache-Control')).toBe('no-store')
        expect(response.headers.get('Content-Type')).toContain(path.endsWith('.docx') ? 'wordprocessingml.document' : 'application/json')
      }
    }
    expect(env.accesses).toHaveLength(10)
    expect(await (await worker.fetch(request('/api/health'), {})).json()).toMatchObject({ status: 'ok', access: 'public' })
  })
  it('has no login, refresh, website proxy or arbitrary file route', async () => {
    const env = environment()
    for (const path of ['/api/session', '/public/data/orbit-passes.json', '/api/weather', '/refresh', '/.dev.vars', '/documents/unknown.docx']) {
      expect((await worker.fetch(request(path), env)).status).toBe(404)
    }
    expect((await worker.fetch(request('/data/orbits.json', 'POST'), env)).status).toBe(405)
    expect(env.accesses).toEqual([])
  })
  it('reports unavailable assets instead of returning a successful empty document', async () => {
    const response = await worker.fetch(request('/documents/all.docx'), { ASSETS: { fetch: async () => new Response(null, { status: 404 }) } })
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: 'DATA_NOT_READY' } })
  })
})
