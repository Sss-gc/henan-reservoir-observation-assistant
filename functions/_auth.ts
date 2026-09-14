const encoder = new TextEncoder()
const SESSION_COOKIE = '__Host-hroa_session'
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60

interface SessionPayload {
  version: 1
  email: string
  issuedAt: number
  expiresAt: number
}

function encodeBase64Url(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function decodeBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url value')
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

async function importSessionKey(secret: string) {
  return crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
  )
}

function readCookie(request: Request, name: string) {
  const header = request.headers.get('Cookie') ?? ''
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue
    return part.slice(separator + 1).trim()
  }
  return null
}

export async function createSessionToken(email: string, secret: string, now = Date.now()) {
  const payload: SessionPayload = {
    version: 1,
    email: email.trim().toLowerCase(),
    issuedAt: Math.floor(now / 1000),
    expiresAt: Math.floor(now / 1000) + SESSION_TTL_SECONDS,
  }
  const encodedPayload = encodeBase64Url(encoder.encode(JSON.stringify(payload)))
  const key = await importSessionKey(secret)
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(encodedPayload))
  return `${encodedPayload}.${encodeBase64Url(new Uint8Array(signature))}`
}

export async function verifySessionToken(token: string, expectedEmail: string, secret: string, now = Date.now()) {
  try {
    const [encodedPayload, encodedSignature, extra] = token.split('.')
    if (!encodedPayload || !encodedSignature || extra) return false
    const key = await importSessionKey(secret)
    const validSignature = await crypto.subtle.verify(
      'HMAC', key, decodeBase64Url(encodedSignature), encoder.encode(encodedPayload),
    )
    if (!validSignature) return false
    const payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(encodedPayload))) as Partial<SessionPayload>
    const currentTime = Math.floor(now / 1000)
    return payload.version === 1 &&
      payload.email === expectedEmail.trim().toLowerCase() &&
      typeof payload.issuedAt === 'number' && payload.issuedAt <= currentTime + 60 &&
      typeof payload.expiresAt === 'number' && payload.expiresAt > currentTime
  } catch {
    return false
  }
}

export async function requestHasValidSession(request: Request, env: Env) {
  const token = readCookie(request, SESSION_COOKIE)
  if (!token || !env.AUTH_SESSION_SECRET || !env.AUTH_EMAIL) return false
  return verifySessionToken(token, env.AUTH_EMAIL, env.AUTH_SESSION_SECRET)
}

export async function verifyPassword(password: string, expectedPassword: string) {
  try {
    const [actual, expected] = await Promise.all([
      crypto.subtle.digest('SHA-256', encoder.encode(password)),
      crypto.subtle.digest('SHA-256', encoder.encode(expectedPassword)),
    ])
    const subtle = crypto.subtle as SubtleCrypto & {
      timingSafeEqual(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean
    }
    return subtle.timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

export function sessionCookie(token: string) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`
}

export function expiredSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
}

export function isSameOriginFormPost(request: Request) {
  const url = new URL(request.url)
  const origin = request.headers.get('Origin')
  const fetchSite = request.headers.get('Sec-Fetch-Site')
  if (origin && origin !== 'null') return origin === url.origin
  // Sandboxed in-app browsers legitimately serialize their opaque origin as
  // "null". In that case, retain browser-enforced Fetch Metadata protection.
  if (origin === 'null') return fetchSite !== 'cross-site'
  return !fetchSite || fetchSite === 'same-origin' || fetchSite === 'same-site' || fetchSite === 'none'
}

export async function rateLimitKey(request: Request, secret: string) {
  const clientAddress = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${secret}:${clientAddress}`))
  return `auth:fail:${encodeBase64Url(new Uint8Array(digest)).slice(0, 32)}`
}

export function secureDynamicHeaders(headers = new Headers()) {
  headers.set('Cache-Control', 'private, no-store, max-age=0')
  headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
  headers.set('Referrer-Policy', 'no-referrer')
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('X-Frame-Options', 'DENY')
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  return headers
}
