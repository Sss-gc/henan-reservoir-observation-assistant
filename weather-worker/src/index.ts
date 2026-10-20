import {
  buildWeatherSnapshot, RESERVOIR_STATIONS, WEATHER_SNAPSHOT_KEY,
} from './nmc'

declare global {
  interface Env {
    GITHUB_WORKFLOW_TOKEN?: string
  }
}

const STATIC_WEATHER_URL = 'https://sss-gc.github.io/henan-reservoir-observation-assistant/data/weather.json'
const GITHUB_DISPATCH_URL = 'https://api.github.com/repos/Sss-gc/henan-reservoir-observation-assistant/actions/workflows/refresh-miniprogram-static.yml/dispatches'

function beijingDay(value: string) {
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time + 8 * 3600000).toISOString().slice(0, 10) : ''
}

export function hasCurrentStaticWeather(payload: unknown, now = new Date()) {
  if (!payload || typeof payload !== 'object') return false
  const weather = payload as { pipeline?: unknown; source?: unknown; generatedAt?: unknown; items?: unknown }
  if (weather.pipeline !== 'miniprogram-static-independent-v1' || weather.source !== '中央气象台' ||
      typeof weather.generatedAt !== 'string' || beijingDay(weather.generatedAt) !== beijingDay(now.toISOString()) ||
      !weather.items || typeof weather.items !== 'object') return false
  const items = Object.values(weather.items as Record<string, {
    fetchedAt?: unknown; publishedAt?: unknown; days?: unknown
  }>)
  const today = beijingDay(now.toISOString())
  return items.length === RESERVOIR_STATIONS.length && items.every((item) =>
    typeof item.fetchedAt === 'string' && beijingDay(item.fetchedAt) === today &&
    typeof item.publishedAt === 'string' && beijingDay(item.publishedAt) === today &&
    Array.isArray(item.days) && item.days.length === 7)
}

export async function ensureStaticWeatherRefresh(env: Env, now = new Date(), fetcher: typeof fetch = fetch) {
  let alreadyCurrent = false
  try {
    const response = await fetcher(`${STATIC_WEATHER_URL}?watchdog=${now.getTime()}`, {
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(20_000),
    })
    alreadyCurrent = response.ok && hasCurrentStaticWeather(await response.json(), now)
  } catch {
    // A failed freshness probe must not suppress the recovery dispatch.
  }
  if (alreadyCurrent) return 'already-current' as const
  if (!env.GITHUB_WORKFLOW_TOKEN) throw new Error('缺少Cloudflare加密变量GITHUB_WORKFLOW_TOKEN')
  const response = await fetcher(GITHUB_DISPATCH_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json', Authorization: `Bearer ${env.GITHUB_WORKFLOW_TOKEN}`,
      'Content-Type': 'application/json', 'User-Agent': 'henan-reservoir-weather-watchdog',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ ref: 'main' }), signal: AbortSignal.timeout(20_000),
  })
  if (response.status !== 204) {
    await response.body?.cancel()
    throw new Error(`GitHub工作流触发失败：HTTP ${response.status}`)
  }
  return 'dispatched' as const
}

export async function refreshWeather(env: Env, now = new Date()) {
  const previous = await env.WEATHER_KV.get<import('./nmc').WeatherSnapshot>(WEATHER_SNAPSHOT_KEY, 'json')
  const snapshot = await buildWeatherSnapshot((milliseconds) => scheduler.wait(milliseconds), now, previous)
  await env.WEATHER_KV.put(WEATHER_SNAPSHOT_KEY, JSON.stringify(snapshot))
  console.log(JSON.stringify({
    event: 'weather_refresh_complete', reservoirs: RESERVOIR_STATIONS.length,
    updatedReservoirs: RESERVOIR_STATIONS.length - snapshot.staleReservoirIds.length,
    staleReservoirs: snapshot.staleReservoirIds.length,
    stations: new Set(RESERVOIR_STATIONS.map((item) => item.slug)).size,
    generatedAt: snapshot.generatedAt,
  }))
  return snapshot
}

export default {
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    let weatherError: unknown
    try {
      await refreshWeather(env)
    } catch (error) {
      weatherError = error
      console.error(JSON.stringify({ event: 'weather_refresh_failed', error: error instanceof Error ? error.message : String(error) }))
    }
    let dispatchError: unknown
    try {
      const result = await ensureStaticWeatherRefresh(env)
      console.log(JSON.stringify({ event: 'mini_static_watchdog_complete', result }))
    } catch (error) {
      dispatchError = error
      console.error(JSON.stringify({ event: 'mini_static_watchdog_failed', error: error instanceof Error ? error.message : String(error) }))
    }
    const errors = [weatherError, dispatchError].filter((error) => error !== undefined)
    if (errors.length) throw new AggregateError(errors, '定时天气刷新或小程序静态数据触发失败')
  },
}
