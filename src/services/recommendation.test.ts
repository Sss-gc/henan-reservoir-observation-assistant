import { describe, expect, it } from 'vitest'
import type { SatellitePass, WeatherResult } from '../types'
import { buildExperimentRecommendation } from './recommendation'

const satellitePass: SatellitePass = {
  id: 'pass-1', reservoir_id: 'HN_RSV_001', date: '2026-09-01', time: '10:25',
  timezone: 'Asia/Shanghai', time_utc: '2026-09-01T02:25:00Z', satellite: 'Sentinel-2A',
  sensor: 'MSI', resolution_m: 10, swath_km: 290, confidence: 'B', coverage: 100,
  min_distance_km: 2, coverage_method: 'polygon-intersection', element_epoch: '2026-08-28T00:00:00Z',
  solar_elevation_deg: 55, solar_azimuth_deg: 150, satellite_elevation_deg: 80,
  satellite_azimuth_deg: 350, glint_angle_deg: 55, glint_risk: 'minimal',
  is_imaging_confirmed: false,
}

function weather(condition: string): WeatherResult {
  return {
    source: '中央气象台', sourceUrl: 'https://www.nmc.cn/example', stationName: '安阳',
    publishedAt: '2026-09-01T08:00:00+08:00', fetchedAt: '2026-09-01T01:00:00Z', cacheStatus: 'test',
    days: [{ date: '2026-09-01', dayCondition: condition, nightCondition: '多云' }],
  }
}

describe('experiment recommendation', () => {
  it('recommends a clear day with low sunglint risk', () => {
    const result = buildExperimentRecommendation(satellitePass, weather('晴'))
    expect(result.level).toBe('推荐')
    expect(result.score).toBeGreaterThanOrEqual(75)
  })

  it('marks windows beyond the seven-day forecast as pending', () => {
    const result = buildExperimentRecommendation({ ...satellitePass, date: '2026-10-01' }, weather('晴'))
    expect(result.level).toBe('待预报')
    expect(result.score).toBeNull()
  })

  it('rejects rainy weather', () => {
    expect(buildExperimentRecommendation(satellitePass, weather('中雨')).level).toBe('不推荐')
  })

  it('does not recommend a geometrically high-risk sunglint window', () => {
    const result = buildExperimentRecommendation({ ...satellitePass, glint_angle_deg: 6, glint_risk: 'high' }, weather('晴'))
    expect(result.level).not.toBe('推荐')
    expect(result.reasons.at(-1)).toContain('耀光高风险')
  })
})
