import type { ExperimentRecommendation, OrbitPassPayload, ReservoirProperties, WeatherResult } from '../types'
import { createAllReservoirReportBlob } from './all-reservoir-report'
import { isSupportedObservationPass } from './satellite'

export interface ObservationPlanDocumentData {
  reservoir: ReservoirProperties
  recommendations: ExperimentRecommendation[]
  bestRecommendations: ExperimentRecommendation[]
  satelliteFilter: string
  orbitPayload: OrbitPassPayload | null
  weather: WeatherResult | null
  generatedAt?: Date
}

const FAMILY_ORDER = ['Sentinel', 'HJ', 'Landsat', 'GF'] as const
type Family = typeof FAMILY_ORDER[number]

function family(satellite: string): Family {
  if (satellite.startsWith('Sentinel')) return 'Sentinel'
  if (satellite.startsWith('HJ')) return 'HJ'
  if (satellite.startsWith('Landsat')) return 'Landsat'
  return 'GF'
}

export function sortRecommendationsBySatelliteFamily(items: ExperimentRecommendation[]) {
  return [...items].sort((a, b) => FAMILY_ORDER.indexOf(family(a.satellitePass.satellite))
    - FAMILY_ORDER.indexOf(family(b.satellitePass.satellite))
    || a.satellitePass.satellite.localeCompare(b.satellitePass.satellite, 'zh-CN', { numeric: true })
    || a.satellitePass.date.localeCompare(b.satellitePass.date)
    || a.satellitePass.time.localeCompare(b.satellitePass.time))
}

export function selectDocumentBestRecommendations(items: ExperimentRecommendation[]) {
  return items.filter((item) => item.level === '推荐' && item.weatherDay?.dayCondition.trim() === '晴'
    && isSupportedObservationPass(item.satellitePass))
    .sort((a, b) => FAMILY_ORDER.indexOf(family(a.satellitePass.satellite))
      - FAMILY_ORDER.indexOf(family(b.satellitePass.satellite))
      || (b.score ?? -1) - (a.score ?? -1)
      || a.satellitePass.time_utc.localeCompare(b.satellitePass.time_utc))
    .slice(0, 4)
}

function fallbackPayload(items: ExperimentRecommendation[]): OrbitPassPayload {
  const passes = items.map((item) => item.satellitePass)
  return {
    schema_version: 'single-reservoir-report', generated_at: new Date().toISOString(), timezone: 'Asia/Shanghai',
    forecast_days: 7, source: '当前页面轨道数据', element_epoch_latest: null, coverage_rule: '完整覆盖',
    coverage_method: '完整覆盖', glint_method: '几何估算', glint_thresholds_deg: { high: 10, medium: 20, low: 40 },
    is_imaging_confirmed: false, warning: '', reservoir_count: 1, reservoirs_with_passes: passes.length ? 1 : 0,
    item_count: passes.length, items: passes,
  }
}

export async function createObservationPlanBlob(data: ObservationPlanDocumentData) {
  const recommendations = data.recommendations.filter((item) => isSupportedObservationPass(item.satellitePass))
  const items = recommendations.map((item) => item.satellitePass)
  const payload = data.orbitPayload
    ? { ...data.orbitPayload, items, item_count: items.length }
    : fallbackPayload(recommendations)
  const recommendationDays = recommendations.flatMap((item) => item.weatherDay ? [item.weatherDay] : [])
  const weather: WeatherResult | null = data.weather ?? (recommendationDays.length ? {
    source: '当前页面天气', sourceUrl: '', stationName: data.reservoir.city, publishedAt: null,
    fetchedAt: new Date().toISOString(), cacheStatus: 'document-data',
    days: [...new Map(recommendationDays.map((day) => [day.date, day])).values()],
  } : null)
  return createAllReservoirReportBlob({
    reservoirs: [data.reservoir], orbitPayload: payload,
    weatherByReservoir: weather ? { [data.reservoir.id]: weather } : {},
    generatedAt: data.generatedAt,
    reportTitle: `${data.reservoir.name_cn}未来7天晴天实验方案`,
  })
}

export function observationPlanFileName(reservoirName: string, generatedAt = new Date()) {
  const date = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Shanghai',
  }).format(generatedAt).replaceAll('/', '')
  const safeName = reservoirName.replace(/[\\/:*?"<>|]+/g, '_').trim().replace(/[ ._]+$/g, '') || '水库'
  return `${safeName}_未来7天晴天实验方案_${date}.docx`
}

export async function downloadObservationPlan(data: ObservationPlanDocumentData) {
  const blob = await createObservationPlanBlob(data)
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = observationPlanFileName(data.reservoir.name_cn, data.generatedAt)
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
