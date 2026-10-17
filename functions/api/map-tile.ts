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
      cf: { cacheTtl: 86400, cacheEverything: true } })
    const type = response.headers.get('Content-Type') ?? ''
    if (!response.ok || !/^image\/(png|jpeg|webp)/i.test(type)) {
      return Response.json({ error: '天地图瓦片暂不可用，请核验服务许可与配额' }, { status: 502 })
    }
    return new Response(response.body, { headers: { 'Content-Type': type,
      'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' } })
  } catch {
    return Response.json({ error: '天地图连接失败，请稍后重试' }, { status: 502 })
  }
}
