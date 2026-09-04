import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import JSZip from 'jszip'
import { DOMParser } from '@xmldom/xmldom'
import type { ExperimentRecommendation } from '../types'
import { createObservationPlanBlob, observationPlanFileName, selectDocumentBestRecommendations, sortRecommendationsBySatelliteFamily } from './document'
import { HJ_CCD_SENSOR, isSupportedObservationPass, normalizeObservationPass } from './satellite'

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

const withSatellite = (satellite: string, date: string): ExperimentRecommendation => ({
  ...recommendation,
  satellitePass: { ...recommendation.satellitePass, id: `${satellite}-${date}`, satellite, date, sensor: satellite === 'HJ-2B' ? HJ_CCD_SENSOR : 'MSI' },
})

const mixedSatelliteRecommendations = [
  withSatellite('Gaofen-1', '2026-09-04'),
  withSatellite('Landsat 9', '2026-09-03'),
  withSatellite('HJ-2B', '2026-09-02'),
  withSatellite('Sentinel-2C', '2026-09-05'),
  withSatellite('Sentinel-2A', '2026-09-06'),
]

describe('observation plan document', () => {
  beforeEach(async () => {
    const template = await readFile('src/assets/observation-plan-template.docx')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(template)))
  })
  afterEach(() => vi.unstubAllGlobals())
  it('creates a valid docx package in the browser-compatible Blob format', async () => {
    const blob = await createObservationPlanBlob({
      reservoir: {
        id: 'sample', code: 'HNSK-001', name_cn: '示例水库', city: '郑州市', lon: 113.65, lat: 34.76,
        area_km2: 12.34, osm_id: '', feature_class: 'reservoir', data_source: 'test', geometry_status: 'verified',
      },
      recommendations: process.env.DOCX_QA_OUTPUT
        ? Array.from({ length: 30 }, (_, index) => mixedSatelliteRecommendations[index % mixedSatelliteRecommendations.length])
        : mixedSatelliteRecommendations,
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
    const zip = await JSZip.loadAsync(bytes)
    const xml = await zip.file('word/document.xml')!.async('string')
    expect(xml).not.toContain('{{')
    expect(xml).not.toContain('10:24')
    expect(xml).not.toContain('日期时间')
    expect(xml).toContain('日期')
    expect(xml).toContain('Times New Roman')
    expect(xml).toContain('宋体')
    const parsed = new DOMParser().parseFromString(xml, 'application/xml')
    const tables = parsed.getElementsByTagName('w:tbl')
    expect(tables.length).toBe(4)
    const firstBest = tables[1].getElementsByTagName('w:tr')[1]
    expect(firstBest.textContent).toContain('Sentinel')
    for (const index of [1, 2]) {
      for (const row of Array.from(tables[index].getElementsByTagName('w:tr')).slice(1)) {
        const cells = row.getElementsByTagName('w:tc')
        if (cells.length === 6) expect(cells[0].textContent).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      }
    }
    const templateZip = await JSZip.loadAsync(await readFile('src/assets/observation-plan-template.docx'))
    for (const name of Object.keys(templateZip.files).filter(name => !name.endsWith('/') && name !== 'word/document.xml')) {
      expect(await zip.file(name)!.async('uint8array')).toEqual(await templateZip.file(name)!.async('uint8array'))
    }

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

  it('groups joint judgments as Sentinel, HJ, Landsat, then GF', () => {
    const sorted = sortRecommendationsBySatelliteFamily(mixedSatelliteRecommendations)
    expect(sorted.map((item) => item.satellitePass.satellite))
      .toEqual(['Sentinel-2A', 'Sentinel-2C', 'HJ-2B', 'Landsat 9', 'Gaofen-1'])
  })

  it('chooses eligible Sentinel windows before higher scoring alternatives, from the full list', () => {
    const alternatives = ['Gaofen-1', 'HJ-2B', 'Landsat 9', 'Landsat 8'].map(name => ({ ...withSatellite(name, '2026-09-05'), score: 100 }))
    const sentinel = { ...recommendation, score: 75 }
    const rejected = { ...withSatellite('Sentinel-2A', '2026-09-06'), score: 80, level: '备选' as const }
    const input = [...alternatives, sentinel, rejected]
    expect(selectDocumentBestRecommendations(input)[0]).toBe(sentinel)
    expect(selectDocumentBestRecommendations(input)).not.toContain(rejected)
    expect(selectDocumentBestRecommendations(input)).toHaveLength(4)
    expect(input[0]).toBe(alternatives[0])
    expect(selectDocumentBestRecommendations([rejected])).toEqual([])
  })

  it('accepts only HJ-2B CCD and preserves the original web time when normalizing legacy labels', () => {
    expect(isSupportedObservationPass({ satellite: 'HJ-2B', sensor: HJ_CCD_SENSOR })).toBe(true)
    for (const satellite of ['HJ-2A', 'HJ-1B']) expect(isSupportedObservationPass({ satellite, sensor: 'CCD1' })).toBe(false)
    for (const sensor of ['IRS', 'HSI']) expect(isSupportedObservationPass({ satellite: 'HJ-2B', sensor })).toBe(false)
    const pass = { ...recommendation.satellitePass, satellite: 'HJ-2B', sensor: '16m WVC-2 (4-camera composite)' }
    expect(normalizeObservationPass(pass)).toEqual({ ...pass, sensor: HJ_CCD_SENSOR })
    expect(pass.sensor).toBe('16m WVC-2 (4-camera composite)')
  })

  it('exports explicit empty states without stale template records', async () => {
    const blob = await createObservationPlanBlob({
      reservoir: { id: 'x', code: 'x', name_cn: '测试水库', city: '测试城市', lon: 113, lat: 34, area_km2: 1, osm_id: '', feature_class: 'reservoir', data_source: 'test', geometry_status: 'verified' },
      recommendations: [], bestRecommendations: [recommendation], thresholds: { maxCloud: 30, maxRainProbability: 25, maxWind: 5 },
      satelliteFilter: '全部卫星', orbitPayload: null, weather: null,
    })
    const zip = await JSZip.loadAsync(await blob.arrayBuffer())
    const xml = await zip.file('word/document.xml')!.async('string')
    expect(xml).toContain('暂无“推荐”窗口')
    expect(xml).toContain('没有完整覆盖窗口')
    expect(xml).not.toContain('{{')
    expect(xml).not.toContain('Sentinel-2C')
    expect(await zip.file('docProps/core.xml')!.async('string')).not.toContain('W3CDTF')
  })
})
