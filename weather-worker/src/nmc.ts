export const WEATHER_SNAPSHOT_KEY = 'weather:latest'
export const USER_AGENT = 'HenanReservoirWeather/1.0 (personal research; contact: 306221976@qq.com)'
export const MAX_HTML_BYTES = 256_000

export interface ReservoirStation { reservoirId: string; stationName: string; slug: string }
export interface ForecastDay { date: string; dayCondition: string; nightCondition: string }
export interface ReservoirForecast {
  reservoirId: string
  stationName: string
  sourceUrl: string
  publishedAt: string | null
  fetchedAt: string
  forecast: ForecastDay[]
}
export interface WeatherSnapshot {
  schemaVersion: 'nmc-text-v1'
  source: '中央气象台'
  generatedAt: string
  staleReservoirIds: string[]
  reservoirs: Record<string, ReservoirForecast>
}

export const RESERVOIR_STATIONS: ReservoirStation[] = [
  { reservoirId: 'HN_RSV_001', stationName: '安阳', slug: 'anyang' },
  { reservoirId: 'HN_RSV_002', stationName: '嵩县', slug: 'zuoxian3' },
  { reservoirId: 'HN_RSV_003', stationName: '鲁山', slug: 'lushan' },
  { reservoirId: 'HN_RSV_004', stationName: '罗山', slug: 'luoshan' },
  { reservoirId: 'HN_RSV_005', stationName: '泌阳', slug: 'miyang' },
  { reservoirId: 'HN_RSV_006', stationName: '泌阳', slug: 'miyang' },
  { reservoirId: 'HN_RSV_007', stationName: '林州', slug: 'linzhou' },
  { reservoirId: 'HN_RSV_008', stationName: '叶县', slug: 'yexian' },
  { reservoirId: 'HN_RSV_009', stationName: '舞钢', slug: 'wugang' },
  { reservoirId: 'HN_RSV_010', stationName: '洛宁', slug: 'luoning' },
  { reservoirId: 'HN_RSV_011', stationName: '灵宝', slug: 'lingbao' },
  { reservoirId: 'HN_RSV_012', stationName: '南召', slug: 'nanzhao' },
  { reservoirId: 'HN_RSV_013', stationName: '光山', slug: 'guangshan' },
  { reservoirId: 'HN_RSV_014', stationName: '平顶山', slug: 'pingdingshan' },
  { reservoirId: 'HN_RSV_015', stationName: '郑州', slug: 'zhengzhou' },
  { reservoirId: 'HN_RSV_016', stationName: '济源', slug: 'jiyuan' },
  { reservoirId: 'HN_RSV_017', stationName: '三门峡', slug: 'sanmenxia' },
  { reservoirId: 'HN_RSV_018', stationName: '汝南', slug: 'runan' },
  { reservoirId: 'HN_RSV_019', stationName: '光山', slug: 'guangshan' },
  { reservoirId: 'HN_RSV_020', stationName: '商城', slug: 'shangcheng' },
  { reservoirId: 'HN_RSV_021', stationName: '信阳', slug: 'xinyang' },
  { reservoirId: 'HN_RSV_022', stationName: '信阳', slug: 'xinyang' },
  { reservoirId: 'HN_RSV_023', stationName: '确山', slug: 'queshan' },
  { reservoirId: 'HN_RSV_024', stationName: '淅川', slug: 'zuochuan2' },
  { reservoirId: 'HN_RSV_025', stationName: '禹州', slug: 'yuzhou' },
]

function plainText(value: string) {
  return value.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim()
}

function normalizeCondition(value: string) {
  const condition = plainText(value).replace(/[^\u3400-\u9fffA-Za-z0-9～~—-]/g, '')
  if (!condition || condition.length > 16) throw new Error('天气状况字段无效')
  return condition
}

function resolveForecastDate(month: number, day: number, now: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Shanghai',
  }).formatToParts(now)
  const currentYear = Number(parts.find((part) => part.type === 'year')?.value)
  const todayMonth = Number(parts.find((part) => part.type === 'month')?.value)
  let year = currentYear
  if (todayMonth === 12 && month === 1) year += 1
  if (todayMonth === 1 && month === 12) year -= 1
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function parseNmcForecast(html: string, now = new Date()): { forecast: ForecastDay[]; publishedAt: string | null } {
  if (/404错误页面|验证码|访问过于频繁/.test(html)) throw new Error('中央气象台返回了错误或访问限制页面')
  const marker = html.search(/id=["']?day7["']?/i)
  if (marker < 0) throw new Error('未找到中央气象台7天天气区域')
  const section = html.slice(marker, marker + 16_000)
  const blocks = section.split(/<div\s+class=["']?weather\s+pull-left[^>]*>/i).slice(1, 8)
  if (blocks.length !== 7) throw new Error(`预报天数异常：${blocks.length}`)
  const forecast = blocks.map((block) => {
    const dateMatch = block.match(/class=["']?date["']?[^>]*>[\s\S]*?(\d{2})\/(\d{2})/i)
    const rawDescriptions = [...block.matchAll(/class=["']?desc["']?[^>]*>([\s\S]*?)<\/div>/gi)]
      .map((match) => plainText(match[1]))
    if (!dateMatch || rawDescriptions.length !== 2) throw new Error('预报日期或昼夜天气字段缺失')
    const descriptions = rawDescriptions.map((condition, index) => condition
      ? normalizeCondition(condition)
      : index === 0 ? '时段已过' : '暂无')
    return {
      date: resolveForecastDate(Number(dateMatch[1]), Number(dateMatch[2]), now),
      dayCondition: descriptions[0], nightCondition: descriptions[1],
    }
  })
  if (new Set(forecast.map((day) => day.date)).size !== 7) throw new Error('预报日期存在重复')
  const published = html.match(/发布时间[：:]\s*(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/)
  return {
    forecast,
    publishedAt: published
      ? `${resolveForecastDate(Number(published[1]), Number(published[2]), now)}T${published[3]}:${published[4]}:00+08:00`
      : null,
  }
}

async function readLimitedHtml(response: Response) {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    totalBytes += value.byteLength
    if (totalBytes > MAX_HTML_BYTES) {
      await reader.cancel()
      throw new Error('中央气象台页面超过安全大小限制')
    }
    chunks.push(value)
  }
  const body = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

async function fetchStation(slug: string, stationName: string, fetcher: typeof fetch) {
  const sourceUrl = `https://www.nmc.cn/publish/forecast/AHA/${slug}.html`
  const response = await fetcher(sourceUrl, {
    headers: { Accept: 'text/html', 'User-Agent': USER_AGENT }, redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  })
  if (response.status === 403 || response.status === 429) throw new Error(`中央气象台拒绝请求：HTTP ${response.status}`)
  if (!response.ok) throw new Error(`中央气象台${stationName}页面返回HTTP ${response.status}`)
  const declaredLength = Number(response.headers.get('content-length') ?? 0)
  if (declaredLength > MAX_HTML_BYTES) throw new Error('中央气象台页面超过安全大小限制')
  const html = await readLimitedHtml(response)
  return { sourceUrl, ...parseNmcForecast(html) }
}

export async function buildWeatherSnapshot(
  wait: (milliseconds: number) => Promise<void>,
  now = new Date(),
  previous?: WeatherSnapshot | null,
  fetcher: typeof fetch = fetch,
) {
  const stationResults = new Map<string, Awaited<ReturnType<typeof fetchStation>>>()
  const uniqueStations = [...new Map(RESERVOIR_STATIONS.map((station) => [station.slug, station])).values()]
  for (const [index, station] of uniqueStations.entries()) {
    try {
      stationResults.set(station.slug, await fetchStation(station.slug, station.stationName, fetcher))
    } catch (error) {
      console.error(JSON.stringify({
        event: 'weather_station_refresh_failed', station: station.stationName, slug: station.slug,
        error: error instanceof Error ? error.message : String(error),
      }))
    }
    if (index < uniqueStations.length - 1) await wait(3_000)
  }
  const fetchedAt = now.toISOString()
  const staleReservoirIds: string[] = []
  const reservoirs = Object.fromEntries(RESERVOIR_STATIONS.map((station) => {
    const result = stationResults.get(station.slug)
    if (!result) {
      const fallback = previous?.reservoirs[station.reservoirId]
      if (!fallback) throw new Error(`缺少${station.stationName}预报结果且没有可用历史缓存`)
      staleReservoirIds.push(station.reservoirId)
      return [station.reservoirId, {
        ...fallback,
        fetchedAt: fallback.fetchedAt ?? previous.generatedAt,
      } satisfies ReservoirForecast]
    }
    return [station.reservoirId, {
      reservoirId: station.reservoirId, stationName: station.stationName, sourceUrl: result.sourceUrl,
      publishedAt: result.publishedAt, fetchedAt, forecast: result.forecast,
    } satisfies ReservoirForecast]
  }))
  return {
    schemaVersion: 'nmc-text-v1', source: '中央气象台', generatedAt: fetchedAt,
    staleReservoirIds, reservoirs,
  } satisfies WeatherSnapshot
}
