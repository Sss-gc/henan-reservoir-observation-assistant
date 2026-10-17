export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const query = new URL(request.url).searchParams
  const layer = query.get('layer')
  const values = ['z', 'x', 'y'].map((name) => query.get(name) ?? '')
  const [z, x, y] = values.map(Number)
  if (!values.every((value) => /^\d+$/.test(value)) || (layer !== 'vec' && layer !== 'cva') ||
      z < 4 || z > 18 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) {
    return Response.json({ error: '瓦片参数无效' }, { status: 400 })
  }
  if (!env.TIANDITU_SERVER_KEY) return Response.json({ error: '天地图服务端key尚未配置' }, { status: 503 })
  const url = new URL(`https://t${(x + y) % 8}.tianditu.gov.cn/${layer}_w/wmts`)
  url.search = new URLSearchParams({ SERVICE: 'WMTS', REQUEST: 'GetTile', VERSION: '1.0.0',
    LAYER: layer, STYLE: 'default', TILEMATRIXSET: 'w', FORMAT: 'tiles',
    TILECOL: String(x), TILEROW: String(y), TILEMATRIX: String(z), tk: env.TIANDITU_SERVER_KEY }).toString()
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'manual',
      cf: { cacheTtlByStatus: { '200-299': 86400, '400-599': 0 }, cacheEverything: true } })
    const bytes = new Uint8Array(await response.arrayBuffer())
    // WMTS servers may send valid images with a generic binary Content-Type.
    const type = bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 &&
      bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10 ? 'image/png' :
      bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg' :
      bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
      String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP' ? 'image/webp' : ''
    if (!response.ok || !type) {
      let upstreamCode = '', message = ''
      try {
        const body = JSON.parse(new TextDecoder().decode(bytes.slice(0, 4096))) as { code?: unknown, msg?: unknown }
        if (/^\d{1,10}$/.test(String(body.code))) upstreamCode = String(body.code)
        if (typeof body.msg === 'string') message = body.msg.replaceAll(env.TIANDITU_SERVER_KEY, '[redacted]').slice(0, 120)
      } catch { /* Non-JSON failures are described by status and media type below. */ }
      const contentType = response.headers.get('Content-Type') ?? '未标注'
      console.warn(JSON.stringify({ event: 'tianditu_tile_error', status: response.status, contentType, upstreamCode }))
      return Response.json({ error: `天地图响应异常（HTTP ${response.status}${upstreamCode ? `，错误码 ${upstreamCode}` : ''}）${message || `：未收到有效图片，类型 ${contentType}`}` }, { status: 502 })
    }
    return new Response(bytes, { headers: { 'Content-Type': type,
      'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' } })
  } catch (error) {
    const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    console.warn(JSON.stringify({ event: 'tianditu_tile_fetch_failed', timeout }))
    return Response.json({ error: timeout ? '天地图上游连接超时，请点击重试' : '天地图上游连接失败，请点击重试' }, { status: 502 })
  }
}
