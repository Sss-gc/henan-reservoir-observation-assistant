import { describe, expect, it } from 'vitest'
import type { SatellitePass, WeatherResult } from '../types'
import { buildExperimentRecommendation, nearestWeatherHour } from './recommendation'

const satellitePass: SatellitePass = {
  id: 'pass-1', reservoir_id: 'HN_RSV_001', date: '2026-09-01', time: '10:25',
  timezone: 'Asia/Shanghai', time_utc: '2026-09-01T02:25:00Z', satellite: 'Sentinel-2A',
  sensor: 'MSI', resolution_m: 10, swath_km: 290, confidence: 'B', coverage: 100,
  min_distance_km: 2, coverage_method: 'polygon-intersection', element_epoch: '2026-08-28T00:00:00Z',
  is_imaging_confirmed: false,
}

function weather(cloud: number, rain: number, wind: number): WeatherResult {
  return {
    source: 'test', fetchedAt: '2026-08-28T00:00:00Z', cacheStatus: 'test',
    days: [{ date: '2026-09-01', weatherCode: 1, temperatureMax: 30, temperatureMin: 20, cloudCover: cloud, precipitationProbability: rain, precipitation: 0, windSpeed: wind, radiation: 20 }],
    hours: [
      { time: '2026-09-01T09:00', temperature: 25, cloudCover: 80, precipitationProbability: 60, precipitation: 1, windSpeed: 8 },
      { time: '2026-09-01T10:00', temperature: 26, cloudCover: cloud, precipitationProbability: rain, precipitation: 0, windSpeed: wind },
      { time: '2026-09-01T11:00', temperature: 27, cloudCover: 70, precipitationProbability: 50, precipitation: 0.5, windSpeed: 7 },
    ],
  }
}

const thresholds = { maxCloud: 30, maxRainProbability: 25, maxWind: 5 }

describe('experiment recommendation', () => {
  it('matches the nearest forecast hour to the pass time', () => {
    expect(nearestWeatherHour(satellitePass, weather(10, 5, 2))?.time).toBe('2026-09-01T10:00')
  })

  it('recommends a clear, dry and calm full-coverage window', () => {
    const result = buildExperimentRecommendation(satellitePass, weather(10, 5, 2), thresholds)
    expect(result.level).toBe('推荐')
    expect(result.score).toBeGreaterThanOrEqual(75)
  })

  it('does not recommend a window beyond the weather horizon', () => {
    const result = buildExperimentRecommendation({ ...satellitePass, date: '2026-10-01' }, weather(10, 5, 2), thresholds)
    expect(result.level).toBe('待预报')
    expect(result.score).toBeNull()
  })

  it('rejects high-risk weather', () => {
    const result = buildExperimentRecommendation(satellitePass, weather(95, 90, 12), thresholds)
    expect(result.level).toBe('不推荐')
  })
})
