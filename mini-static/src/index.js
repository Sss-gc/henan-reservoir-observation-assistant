// Private static files. Every asset request passes this authentication worker.
// No database, CloudBase SDK, website API, or runtime report generation.
const encoder = new TextEncoder()
const SESSION_SECONDS = 30 * 86400
const allowedPath = /^\/(?:data\/(?:manifest|orbits|weather)\.json|documents\/(?:all|HN_RSV_\d{3})\.docx)$/

function base64url(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function decode(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid token')
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (character) => character.charCodeAt(0))
}
async function key(secret) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}
async function credentialHash(code) {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(code))))
}
function configured(env) {
  return typeof env.OBSERVER_ACCESS_CODE === 'string' && env.OBSERVER_ACCESS_CODE.length >= 20 &&
    typeof env.OBSERVER_SESSION_SECRET === 'string' && env.OBSERVER_SESSION_SECRET.length >= 32
}
export async function createSession(env, now = Date.now()) {
  const expiresAt = now + SESSION_SECONDS * 1000
  const payload = base64url(encoder.encode(JSON.stringify({ v: 1, exp: expiresAt,
    credential: await credentialHash(env.OBSERVER_ACCESS_CODE) })))
  const signature = await crypto.subtle.sign('HMAC', await key(env.OBSERVER_SESSION_SECRET), encoder.encode(payload))
  return { token: `${payload}.${base64url(new Uint8Array(signature))}`, expiresAt }
}
export async function authorized(request, env, now = Date.now()) {
  if (!configured(env)) return false
  try {
    const bearer = request.headers.get('Authorization') || ''
    if (!bearer.startsWith('Bearer ') || bearer.length > 2048) return false
    const [payload, signature, extra] = bearer.slice(7).split('.')
    if (!payload || !signature || extra) return false
    if (!await crypto.subtle.verify('HMAC', await key(env.OBSERVER_SESSION_SECRET), decode(signature), encoder.encode(payload))) return false
    const value = JSON.parse(new TextDecoder().decode(decode(payload)))
    return value.v === 1 && Number.isFinite(value.exp) && value.exp > now &&
      value.exp <= now + SESSION_SECONDS * 1000 + 60000 &&
      value.credential === await credentialHash(env.OBSERVER_ACCESS_CODE)
  } catch { return false }
}
function headers() {
  return new Headers({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'Strict-Transport-Security': 'max-age=31536000' })
}
function json(data, status = 200) { return Response.json(data, { status, headers: headers() }) }
function failure(code, message, status) { return json({ ok: false, error: { code, message } }, status) }

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/api/health' && request.method === 'GET') {
      return json({ status: configured(env) ? 'ok' : 'not-configured', service: 'reservoir-mini-static' }, configured(env) ? 200 : 503)
    }
    if (!configured(env)) return failure('NOT_CONFIGURED', '私人访问服务尚未完成配置', 503)
    if (url.pathname === '/api/session' && request.method === 'POST') {
      if (!request.headers.get('Content-Type')?.includes('application/json')) return failure('BAD_REQUEST', '请求格式不正确', 400)
      const raw = await request.text()
      if (raw.length > 1024) return failure('BAD_REQUEST', '请求内容过长', 400)
      let code
      try { code = JSON.parse(raw).accessCode } catch { return failure('BAD_REQUEST', '请求格式不正确', 400) }
      if (typeof code !== 'string' || code.length > 128) return failure('BAD_REQUEST', '请输入访问口令', 400)
      // HMAC verification performs a constant-time comparison in the crypto runtime.
      const comparisonKey = await key(env.OBSERVER_SESSION_SECRET)
      const expected = await crypto.subtle.sign('HMAC', comparisonKey, encoder.encode(env.OBSERVER_ACCESS_CODE))
      if (!await crypto.subtle.verify('HMAC', comparisonKey, expected, encoder.encode(code))) {
        return failure('INVALID_CODE', '访问口令不正确，请向管理员确认', 401)
      }
      return json({ ok: true, data: await createSession(env) })
    }
    if (!await authorized(request, env)) return failure('UNAUTHORIZED', '登录已过期，请重新输入访问口令', 401)
    if (url.pathname === '/api/session' && request.method === 'GET') return json({ ok: true, data: { authorized: true } })
    if (!['GET', 'HEAD'].includes(request.method)) return failure('METHOD_NOT_ALLOWED', '不支持的请求方式', 405)
    if (!allowedPath.test(url.pathname)) return failure('NOT_FOUND', '文件不存在', 404)
    const asset = await env.ASSETS.fetch(new Request(new URL(url.pathname, url.origin), { method: request.method }))
    if (asset.status !== 200) return failure('DATA_NOT_READY', '独立静态数据尚未就绪，请稍后重试', 503)
    const response = new Response(asset.body, { status: 200, headers: headers() })
    response.headers.set('Content-Type', url.pathname.endsWith('.docx')
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/json; charset=utf-8')
    return response
  },
}
