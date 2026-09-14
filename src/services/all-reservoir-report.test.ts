import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import JSZip from 'jszip'
import type { AllReservoirReportData } from './all-reservoir-report'
import type { SatellitePass } from '../types'
import { allReservoirReportFileName, buildAllReservoirReportRecords, buildUnavailableReservoirRecords, createAllReservoirReportBlob } from './all-reservoir-report'

const reservoir = {
  id: 'r1', code: 'HN-001', name_cn: '测试水库', city: '郑州市', lon: 113.6, lat: 34.7,
  area_km2: 10, osm_id: '', feature_class: 'reservoir', data_source: 'test', geometry_status: 'verified',
}

function satellitePass(satellite: string, date = '2026-09-15'): SatellitePass {
  return {
    id: `${satellite}-${date}`, reservoir_id: 'r1', date, time: '10:24', timezone: 'Asia/Shanghai',
    time_utc: `${date}T02:24:00Z`, satellite, sensor: satellite === 'HJ-2B' ? 'CCD (16 m multispectral)' : 'MSI',
    resolution_m: 10, swath_km: 290, confidence: 'B', coverage: 100, min_distance_km: 10,
    coverage_method: 'test', element_epoch: '2026-09-14T00:00:00Z', solar_elevation_deg: 45,
    solar_azimuth_deg: 120, satellite_elevation_deg: 50, satellite_azimuth_deg: 300,
    glint_angle_deg: 40, glint_risk: 'minimal', is_imaging_confirmed: false,
  }
}

const data: AllReservoirReportData = {
  reservoirs: [reservoir],
  orbitPayload: {
    schema_version: '1', generated_at: '2026-09-14T00:00:00Z', timezone: 'Asia/Shanghai', forecast_days: 30,
    source: 'test', element_epoch_latest: '2026-09-14T00:00:00Z', coverage_rule: 'complete', coverage_method: 'test',
    glint_method: 'test', glint_thresholds_deg: { high: 10, medium: 20, low: 30 }, is_imaging_confirmed: false,
    warning: '', reservoir_count: 1, reservoirs_with_passes: 1, item_count: 5,
    items: [satellitePass('Gaofen-1'), satellitePass('Landsat 9'), satellitePass('HJ-2B'), satellitePass('Sentinel-2C'), satellitePass('Sentinel-2A', '2026-09-30')],
  },
  weatherByReservoir: {
    r1: {
      source: '中央气象台', sourceUrl: 'https://example.com', stationName: '郑州', publishedAt: null,
      fetchedAt: '2026-09-14T00:00:00Z', cacheStatus: 'hit',
      days: Array.from({ length: 7 }, (_, index) => ({ date: `2026-09-${15 + index}`, dayCondition: '晴', nightCondition: '多云' })),
    },
  },
  generatedAt: new Date('2026-09-14T04:00:00Z'),
}

describe('all-reservoir seven-day report', () => {
  beforeEach(async () => {
    const template = await readFile('src/assets/observation-plan-template.docx')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(template)))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('keeps only weather-covered dates and orders the four satellite families', () => {
    const records = buildAllReservoirReportRecords(data)
    expect(records.map((item) => item.satellitePass.satellite))
      .toEqual(['Sentinel-2C', 'HJ-2B', 'Landsat 9', 'Gaofen-1'])
    expect(records.every((item) => item.weather === '晴')).toBe(true)
  })

  it('creates a concise docx with all four family sections and requested columns', async () => {
    const blob = await createAllReservoirReportBlob(data)
    const zip = await JSZip.loadAsync(await blob.arrayBuffer())
    const xml = await zip.file('word/document.xml')!.async('string')
    expect(blob.type).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    expect(xml.indexOf('Sentinel 系列')).toBeLessThan(xml.indexOf('HJ 系列'))
    expect(xml.indexOf('HJ 系列')).toBeLessThan(xml.indexOf('Landsat 系列'))
    expect(xml.indexOf('Landsat 系列')).toBeLessThan(xml.indexOf('GF / Gaofen 系列'))
    for (const heading of ['水库', '日期', '过境卫星', '白天天气']) expect(xml).toContain(heading)
    expect(xml).not.toContain('2026-09-30')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('omits non-sunny passes and explains why a reservoir has no plan', () => {
    const cloudy = structuredClone(data)
    cloudy.weatherByReservoir.r1.days[0].dayCondition = '多云'
    expect(buildAllReservoirReportRecords(cloudy)).toEqual([])
    expect(buildUnavailableReservoirRecords(cloudy)[0].reason).toContain('天气不符（多云）')
  })

  it('uses the Beijing date in the report filename', () => {
    expect(allReservoirReportFileName(new Date('2026-09-14T16:30:00Z')))
      .toBe('全部水库_未来7天晴天实验方案简报_20260915.docx')
  })
})
