import type { WeatherResult } from '../types'

const dailyWeatherCache = new Map<string, Promise<WeatherResult>>()
let dailyAllWeatherCache: { day: string, request: Promise<Record<string, WeatherResult>> } | null = null

function beijingDay() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
}

export function weatherSymbol(condition: string) {
  if (condition.includes('雷')) return 'ϟ'
  if (condition.includes('雪') || condition.includes('冰雹')) return '❄'
  if (condition.includes('雨')) return '☂'
  if (condition.includes('雾') || condition.includes('霾') || condition.includes('沙')) return '≋'
  if (condition.includes('阴')) return '☁'
  if (condition.includes('多云')) return '⛅'
  if (condition.includes('晴')) return '☀'
  return '◌'
}

function isWeatherResult(value: unknown): value is WeatherResult {
  if (!value || typeof value !== 'object') return false
  const body = value as Partial<WeatherResult>
  return typeof body.source === 'string'
    && typeof body.sourceUrl === 'string'
    && typeof body.stationName === 'string'
    && typeof body.fetchedAt === 'string'
    && Array.isArray(body.days)
    && body.days.length === 7
    && body.days.every((day) => typeof day?.date === 'string'
      && typeof day?.dayCondition === 'string'
      && typeof day?.nightCondition === 'string')
}

export async function fetchWeather(reservoirId: string): Promise<WeatherResult> {
  const key = `${beijingDay()}:${reservoirId}`
  const cached = dailyWeatherCache.get(key)
  if (cached) return cached
  const request = (async () => {
    const response = await fetch(`/api/weather?id=${encodeURIComponent(reservoirId)}`, {
      headers: { Accept: 'application/json' },
    })
    const body = await response.json().catch(() => null)
    if (!response.ok) {
      const message = body && typeof body.error === 'string' ? body.error : `天气接口返回HTTP ${response.status}`
      throw new Error(message)
    }
    if (!isWeatherResult(body)) throw new Error('天气缓存格式不完整')
    return body
  })()
  dailyWeatherCache.set(key, request)
  request.catch(() => dailyWeatherCache.delete(key))
  return request
}

export async function fetchAllWeather(): Promise<Record<string, WeatherResult>> {
  const day = beijingDay()
  if (dailyAllWeatherCache?.day === day) return dailyAllWeatherCache.request
  const request = (async () => {
    let response: Response | null = null
    let networkError: unknown = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await fetch('/api/weather?all=1', {
          headers: { Accept: 'application/json' },
          credentials: 'same-origin',
        })
        break
      } catch (error) {
        networkError = error
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 350))
      }
    }
    if (!response) throw networkError instanceof Error ? networkError : new Error('天气缓存连接失败')
    const body = await response.json().catch(() => null) as { error?: string, items?: Record<string, unknown> } | null
    if (!response.ok) throw new Error(body?.error ?? `天气接口返回HTTP ${response.status}`)
    if (!body?.items || typeof body.items !== 'object') throw new Error('批量天气缓存格式不完整')
    const items = Object.entries(body.items).filter(([, value]) => isWeatherResult(value))
    if (!items.length) throw new Error('批量天气缓存格式不完整')
    return Object.fromEntries(items) as Record<string, WeatherResult>
  })()
  dailyAllWeatherCache = { day, request }
  request.catch(() => { if (dailyAllWeatherCache?.request === request) dailyAllWeatherCache = null })
  return request
}
