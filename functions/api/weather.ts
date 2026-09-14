const SNAPSHOT_KEY = 'weather:latest'
const RESERVOIR_ID = /^HN_RSV_\d{3}$/
const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'private, max-age=300',
}

interface ForecastDay {
  date: string
  dayCondition: string
  nightCondition: string
}

interface StoredForecast {
  reservoirId: string
  stationName: string
  sourceUrl: string
  publishedAt: string | null
  fetchedAt?: string
  forecast: ForecastDay[]
}

interface WeatherSnapshot {
  schemaVersion: string
  source: string
  generatedAt: string
  staleReservoirIds?: string[]
  reservoirs: Record<string, StoredForecast>
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS })
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const reservoirId = new URL(request.url).searchParams.get('id')?.trim() ?? ''
  if (!RESERVOIR_ID.test(reservoirId)) return json({ error: 'id必须是有效的水库编号' }, 400)

  const snapshot = await env.WEATHER_KV.get<WeatherSnapshot>(SNAPSHOT_KEY, 'json')
  if (!snapshot || snapshot.schemaVersion !== 'nmc-text-v1') {
    return json({ error: '天气缓存尚未初始化，请稍后再试' }, 503)
  }
  const item = snapshot.reservoirs[reservoirId]
  if (!item) return json({ error: '没有找到该水库的天气数据' }, 404)

  return json({
    source: snapshot.source,
    fetchedAt: item.fetchedAt ?? snapshot.generatedAt,
    cacheStatus: snapshot.staleReservoirIds?.includes(reservoirId) ? 'kv-stale-fallback' : 'kv',
    reservoirId: item.reservoirId,
    stationName: item.stationName,
    sourceUrl: item.sourceUrl,
    publishedAt: item.publishedAt,
    days: item.forecast,
  })
}
