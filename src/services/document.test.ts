import { describe, expect, it } from 'vitest'
import type { ExperimentRecommendation } from '../types'
import { createObservationPlanBlob, observationPlanFileName } from './document'

const recommendation: ExperimentRecommendation = {
  satellitePass: {
    id: 'sample-pass', reservoir_id: 'sample', date: '2026-09-05', time: '10:24', timezone: 'Asia/Shanghai',
    time_utc: '2026-09-05T02:24:00Z', satellite: 'Sentinel-2C', sensor: 'MSI', resolution_m: 10,
    swath_km: 290, confidence: 'B', coverage: 100, min_distance_km: 23.5,
    coverage_method: 'ground-track-swath-corridor-v2', element_epoch: '2026-09-01T00:00:00Z',
    solar_elevation_deg: 48.2, solar_azimuth_deg: 135.4, satellite_elevation_deg: 52.1,
    satellite_azimuth_deg: 314.8, glint_angle_deg: 45.3, glint_risk: 'minimal',
    is_imaging_confirmed: false,
  },
  weatherDay: {
    date: '2026-09-05', weatherCode: 1, temperatureMax: 30, temperatureMin: 20,
    cloudCover: 12, precipitationProbability: 5, precipitation: 0, windSpeed: 2.4, radiation: 18,
  },
  weatherHour: {
    time: '2026-09-05T10:00', temperature: 27, cloudCover: 12,
    precipitationProbability: 5, precipitation: 0, windSpeed: 2.4,
  },
  score: 93,
  level: '推荐',
  reasons: ['过境云量12%', '降水概率5%', '风速2.4m/s', '耀光极低风险 45.3°'],
}

describe('observation plan document', () => {
  it('creates a valid docx package in the browser-compatible Blob format', async () => {
    const blob = await createObservationPlanBlob({
      reservoir: {
        id: 'sample', code: 'HNSK-001', name_cn: '示例水库', city: '郑州市', lon: 113.65, lat: 34.76,
        area_km2: 12.34, osm_id: '', feature_class: 'reservoir', data_source: 'test', geometry_status: 'verified',
      },
      recommendations: [recommendation],
      bestRecommendations: [recommendation],
      thresholds: { maxCloud: 30, maxRainProbability: 25, maxWind: 5 },
      satelliteFilter: '全部卫星',
      orbitPayload: null,
      weather: null,
      generatedAt: new Date('2026-09-02T04:00:00Z'),
    })

    const bytes = new Uint8Array(await blob.arrayBuffer())
    expect(blob.type).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    expect(bytes.byteLength).toBeGreaterThan(10_000)
    expect(String.fromCharCode(...bytes.slice(0, 2))).toBe('PK')

    const outputPath = process.env.DOCX_QA_OUTPUT
    if (outputPath) {
      const { writeFile } = await import('node:fs/promises')
      await writeFile(outputPath, bytes)
    }
  })

  it('sanitizes file names and uses the Beijing calendar date', () => {
    expect(observationPlanFileName('白沙/水库:*?', new Date('2026-09-01T16:30:00Z')))
      .toBe('白沙_水库_遥感观测实验计划_20260902.docx')
  })
})
