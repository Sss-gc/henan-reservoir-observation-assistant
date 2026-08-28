interface Env {}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }

function json(payload: unknown, status = 200, cacheControl = 'no-store') {
  return new Response(JSON.stringify(payload), { status, headers: { ...JSON_HEADERS, 'Cache-Control': cacheControl } })
}

export const onRequestGet: PagesFunction<Env> = async ({ request, waitUntil }) => {
  const requestUrl = new URL(request.url)
  const latitude = Number(requestUrl.searchParams.get('latitude'))
  const longitude = Number(requestUrl.searchParams.get('longitude'))
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return json({ error: 'latitude和longitude必须是有效数字' }, 400)
  if (latitude < 30 || latitude > 38 || longitude < 108 || longitude > 117) return json({ error: '坐标超出河南水库服务范围' }, 400)

  const normalizedLat = latitude.toFixed(4)
  const normalizedLon = longitude.toFixed(4)
  const cacheUrl = new URL(requestUrl.origin + '/api/weather')
  cacheUrl.searchParams.set('latitude', normalizedLat)
  cacheUrl.searchParams.set('longitude', normalizedLon)
  const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' })
  const cache = await caches.open('reservoir-weather-v1')
  const cached = await cache.match(cacheKey)
  if (cached) return cached

  const upstream = new URL('https://api.open-meteo.com/v1/forecast')
  upstream.searchParams.set('latitude', normalizedLat)
  upstream.searchParams.set('longitude', normalizedLon)
  upstream.searchParams.set('timezone', 'Asia/Shanghai')
  upstream.searchParams.set('forecast_days', '16')
  upstream.searchParams.set('wind_speed_unit', 'ms')
  upstream.searchParams.set('daily', ['weather_code','temperature_2m_max','temperature_2m_min','precipitation_probability_max','precipitation_sum','wind_speed_10m_max','shortwave_radiation_sum'].join(','))
  upstream.searchParams.set('hourly', ['temperature_2m','cloud_cover','precipitation_probability','precipitation','wind_speed_10m'].join(','))

  try {
    const response = await fetch(upstream, { headers: { Accept: 'application/json' } })
    if (!response.ok) return json({ error: `Open-Meteo返回HTTP ${response.status}` }, 502)
    const result = json({ source: 'Open-Meteo via Cloudflare', cache_status: 'miss', fetched_at: new Date().toISOString(), data: await response.json() }, 200, 'public, max-age=300, s-maxage=7200, stale-while-revalidate=86400')
    waitUntil(cache.put(cacheKey, result.clone()))
    return result
  } catch (error) {
    return json({ error: '天气上游暂不可用', detail: error instanceof Error ? error.message : 'unknown' }, 502)
  }
}
