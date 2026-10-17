// Public independent static data and Word downloads; no login or runtime computation.
const allowedPath = /^\/(?:data\/(?:manifest|orbits|weather)\.json|documents\/(?:all|HN_RSV_\d{3})\.docx)$/
function headers() {
  return new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'Strict-Transport-Security': 'max-age=31536000' })
}
function failure(code, message, status) {
  return Response.json({ ok: false, error: { code, message } }, { status, headers: headers() })
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/api/health' && request.method === 'GET') {
      return Response.json({ status: 'ok', service: 'reservoir-mini-static', access: 'public' }, { headers: headers() })
    }
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
