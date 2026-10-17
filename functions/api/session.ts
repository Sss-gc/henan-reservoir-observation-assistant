import { authenticateCredentials } from '../_auth'

const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!(request.headers.get('Content-Type') ?? '').toLowerCase().startsWith('application/json')) {
    return Response.json({ error: '请使用JSON登录请求' }, { status: 415, headers })
  }
  // Only this endpoint issues a token. Other APIs retain the existing session check.
  const reader = request.body?.getReader()
  if (!reader) return Response.json({ error: '登录信息不完整' }, { status: 400, headers })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 8192) {
        await reader.cancel()
        return Response.json({ error: '提交内容过大' }, { status: 413, headers })
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    let body: { email?: unknown, password?: unknown }
    try { body = JSON.parse(new TextDecoder().decode(bytes)) } catch {
      return Response.json({ error: '登录请求格式无效' }, { status: 400, headers })
    }
    if (!body || typeof body.email !== 'string' || typeof body.password !== 'string' ||
        body.email.length > 254 || body.password.length > 256) {
      return Response.json({ error: '登录信息不完整' }, { status: 400, headers })
    }
    const result = await authenticateCredentials(request, env, body.email, body.password)
    if (result.status !== 200) {
      return Response.json({ error: result.message }, { status: result.status,
        headers: result.status === 429 ? { ...headers, 'Retry-After': '900' } : headers })
    }
    return Response.json({ token: result.token, expiresAt: result.expiresAt }, { headers })
  } catch {
    return Response.json({ error: '登录服务暂时不可用，请稍后重试' }, { status: 503, headers })
  }
}
