import type { WeatherDay, WeatherHour, WeatherResult } from '../types'

const WEATHER_CODES: Record<number, string> = {
  0: '晴', 1: '大部晴朗', 2: '多云', 3: '阴', 45: '雾', 48: '雾凇',
  51: '小毛毛雨', 53: '毛毛雨', 55: '强毛毛雨', 61: '小雨', 63: '中雨',
  65: '大雨', 71: '小雪', 73: '中雪', 75: '大雪', 80: '阵雨', 81: '阵雨',
  82: '强阵雨', 95: '雷雨', 96: '雷雨伴冰雹', 99: '强雷雨伴冰雹',
}

export function weatherLabel(code: number) {
  return WEATHER_CODES[code] ?? '天气变化'
}

export function weatherSymbol(code: number) {
  if (code === 0 || code === 1) return '☀'
  if (code === 2) return '⛅'
  if (code === 3) return '☁'
  if (code === 45 || code === 48) return '≋'
  if (code >= 95) return 'ϟ'
  if (code >= 71 && code <= 77) return '❄'
  if (code >= 51) return '☂'
  return '◌'
}

function dailyCloudAverage(times: string[], values: Array<number | null>) {
  const groups = new Map<string, number[]>()
  times.forEach((time, index) => {
    const value = values[index]
    if (value === null || value === undefined) return
    const date = time.slice(0, 10)
    groups.set(date, [...(groups.get(date) ?? []), value])
  })
  return new Map([...groups].map(([date, entries]) => [
    date,
    Math.round(entries.reduce((sum, value) => sum + value, 0) / entries.length),
  ]))
}

function normalizeOpenMeteo(payload: any, source: string, cacheStatus: string): WeatherResult {
  if (!payload?.daily?.time?.length || !payload?.hourly?.time?.length) {
    throw new Error('天气接口没有返回完整的逐日和逐小时预报')
  }
  const clouds = dailyCloudAverage(payload.hourly.time, payload.hourly.cloud_cover)
  const days: WeatherDay[] = payload.daily.time.map((date: string, index: number) => ({
    date,
    weatherCode: payload.daily.weather_code[index],
    temperatureMax: payload.daily.temperature_2m_max[index],
    temperatureMin: payload.daily.temperature_2m_min[index],
    cloudCover: clouds.get(date) ?? 0,
    precipitationProbability: payload.daily.precipitation_probability_max[index] ?? 0,
    precipitation: payload.daily.precipitation_sum[index] ?? 0,
    windSpeed: payload.daily.wind_speed_10m_max[index] ?? 0,
    radiation: payload.daily.shortwave_radiation_sum[index] ?? 0,
  }))
  const hours: WeatherHour[] = payload.hourly.time.map((time: string, index: number) => ({
    time,
    temperature: payload.hourly.temperature_2m[index] ?? 0,
    cloudCover: payload.hourly.cloud_cover[index] ?? 0,
    precipitationProbability: payload.hourly.precipitation_probability[index] ?? 0,
    precipitation: payload.hourly.precipitation[index] ?? 0,
    windSpeed: payload.hourly.wind_speed_10m[index] ?? 0,
  }))
  return { days, hours, source, fetchedAt: new Date().toISOString(), cacheStatus }
}

function weatherParams(latitude: number, longitude: number) {
  return new URLSearchParams({
    latitude: String(latitude), longitude: String(longitude), timezone: 'Asia/Shanghai',
    forecast_days: '16', wind_speed_unit: 'ms',
    daily: [
      'weather_code', 'temperature_2m_max', 'temperature_2m_min',
      'precipitation_probability_max', 'precipitation_sum', 'wind_speed_10m_max',
      'shortwave_radiation_sum',
    ].join(','),
    hourly: [
      'temperature_2m', 'cloud_cover', 'precipitation_probability',
      'precipitation', 'wind_speed_10m',
    ].join(','),
  })
}

export async function fetchWeather(latitude: number, longitude: number): Promise<WeatherResult> {
  const query = weatherParams(latitude, longitude)
  try {
    const response = await fetch(`/api/weather?${query}`, { headers: { Accept: 'application/json' } })
    if (response.ok) {
      const body = await response.json()
      return normalizeOpenMeteo(body.data ?? body, body.source ?? 'Open-Meteo via Cloudflare', body.cache_status ?? 'edge')
    }
  } catch (error) {
    console.info('Cloudflare天气接口不可用，尝试直接连接Open-Meteo。', error)
  }
  const response = await fetch(`https://api.open-meteo.com/v1/forecast?${query}`)
  if (!response.ok) throw new Error(`Open-Meteo返回HTTP ${response.status}`)
  return normalizeOpenMeteo(await response.json(), 'Open-Meteo direct', 'direct')
}
