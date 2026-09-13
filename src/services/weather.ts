import type { WeatherResult } from '../types'

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
}
