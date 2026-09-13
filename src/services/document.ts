import JSZip from 'jszip'
import { DOMParser, XMLSerializer, type Element as XmlElement } from '@xmldom/xmldom'
import templateUrl from '../assets/observation-plan-template.docx?url'
import type { ExperimentRecommendation, OrbitPassPayload, ReservoirProperties, WeatherResult } from '../types'
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

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
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
  return items.filter(item => item.level === '推荐' && isSupportedObservationPass(item.satellitePass))
    .sort((a, b) => Number(b.satellitePass.satellite.startsWith('Sentinel'))
      - Number(a.satellitePass.satellite.startsWith('Sentinel'))
      || (b.score ?? -1) - (a.score ?? -1)
      || a.satellitePass.time_utc.localeCompare(b.satellitePass.time_utc))
    .slice(0, 4)
}

function timestamp(value?: string | Date | null) {
  if (!value) return '暂无'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hour12: false, timeZone: 'Asia/Shanghai',
  }).format(new Date(value))
}

function children(parent: XmlElement, name: string): XmlElement[] {
  return Array.from(parent.childNodes).filter((node): node is XmlElement =>
    node.nodeType === 1 && node.namespaceURI === W && node.localName === name)
}

// Replace slot text only; retain the reference's paragraph and run formatting.
function setText(p: XmlElement, value: string, color?: string) {
  const doc = p.ownerDocument!
  const firstRun = children(p, 'r')[0]
  const props = firstRun && children(firstRun, 'rPr')[0]?.cloneNode(true) as XmlElement | undefined
  for (const node of Array.from(p.childNodes)) {
    if (!(node.nodeType === 1 && node.localName === 'pPr')) p.removeChild(node)
  }
  const run = doc.createElementNS(W, 'w:r')
  if (props) {
    if (color) {
      let c = props.getElementsByTagNameNS(W, 'color').item(0)
      if (!c) { c = doc.createElementNS(W, 'w:color'); props.appendChild(c) }
      c.setAttributeNS(W, 'w:val', color)
    }
    run.appendChild(props)
  }
  value.split('\n').forEach((line, i) => {
    if (i) run.appendChild(doc.createElementNS(W, 'w:br'))
    const text = doc.createElementNS(W, 'w:t')
    text.setAttribute('xml:space', 'preserve')
    text.appendChild(doc.createTextNode(line))
    run.appendChild(text)
  })
  p.appendChild(run)
}

function populateRow(prototype: XmlElement, item: ExperimentRecommendation) {
  const row = prototype.cloneNode(true) as XmlElement
  const pass = item.satellitePass, day = item.weatherDay
  const values = [pass.date, `${pass.satellite}\n${pass.sensor}`,
    day ? `白天 ${day.dayCondition}\n夜间 ${day.nightCondition}` : '天气尚未发布',
    `${{ high: '高', medium: '中', low: '低', minimal: '极低' }[pass.glint_risk]}\n${pass.glint_angle_deg.toFixed(1)}°`,
    item.score === null ? '—' : String(item.score), item.level]
  const color = { 推荐: '13795B', 备选: '9A6700', 不推荐: 'B42318', 待预报: '607D8B' }[item.level]
  children(row, 'tc').forEach((cell, i) => setText(children(cell, 'p')[0], values[i], i >= 4 ? color : undefined))
  return row
}

export async function createObservationPlanBlob(data: ObservationPlanDocumentData) {
  const response = await fetch(templateUrl)
  if (!response.ok) throw new Error('实验方案模板加载失败，请重试')
  const zip = await JSZip.loadAsync(await response.arrayBuffer())
  const doc = new DOMParser().parseFromString(await zip.file('word/document.xml')!.async('string'), 'application/xml')
  const body = doc.getElementsByTagNameNS(W, 'body').item(0)!
  const tables = children(body, 'tbl')
  const items = data.recommendations.filter(item => isSupportedObservationPass(item.satellitePass))
  const best = selectDocumentBestRecommendations(items)
  const p = data.reservoir
  const replacements: Record<string, string> = {
    TITLE: `${p.name_cn}遥感观测实验计划`,
    GENERATED: `生成时间：${timestamp(data.generatedAt ?? new Date())}（北京时间）`,
    TOTALS: `本次共纳入 ${items.length} 个完整覆盖窗口，其中推荐 ${items.filter(i => i.level === '推荐').length} 个、备选 ${items.filter(i => i.level === '备选').length} 个、待预报 ${items.filter(i => i.level === '待预报').length} 个。`,
    ORBIT_SOURCE: `轨道数据：CelesTrak OMM / SGP4；静态数据生成时间 ${timestamp(data.orbitPayload?.generated_at)}；轨道历元 ${timestamp(data.orbitPayload?.element_epoch_latest)}。`,
    WEATHER_SOURCE: `天气数据：${data.weather?.source ?? '天气尚未获取'}；参考站点 ${data.weather?.stationName ?? '暂无'}；发布时间 ${timestamp(data.weather?.publishedAt)}；缓存更新时间 ${timestamp(data.weather?.fetchedAt)}。仅使用未来7天昼夜文字天气。`,
    SUMMARY_0_1: p.name_cn, SUMMARY_0_3: p.city,
    SUMMARY_1_1: p.code, SUMMARY_1_3: `${p.area_km2.toFixed(2)} km²`,
    SUMMARY_2_1: `${p.lon.toFixed(4)}, ${p.lat.toFixed(4)}`, SUMMARY_2_3: data.satelliteFilter,
    SUMMARY_3_1: '中央气象台7天\n白天 / 夜间天气',
    SUMMARY_3_3: '文字天气判断',
  }
  for (const paragraph of Array.from(doc.getElementsByTagNameNS(W, 'p'))) {
    const key = (paragraph.textContent ?? '').match(/^\{\{([A-Z0-9_]+)\}\}$/)?.[1]
    if (key && key in replacements) setText(paragraph, replacements[key])
    if (paragraph.textContent === '天气阈值') setText(paragraph, '天气来源')
    if (paragraph.textContent === '风速阈值') setText(paragraph, '判断方式')
    if (paragraph.textContent?.startsWith('用途：依据未来完整覆盖轨道窗口、逐小时天气预报')) {
      setText(paragraph, '用途：依据未来完整覆盖轨道窗口、中央气象台7天文字天气与水面耀光几何风险，辅助安排现场同步实验。')
    }
  }
  for (const [index, records] of [[1, best], [2, sortRecommendationsBySatelliteFamily(items)]] as const) {
    const table = tables[index], rows = children(table, 'tr')
    const prototype = rows[rows.length - 1], groupPrototype = index === 2 ? rows[1] : null
    rows.slice(1).forEach(row => table.removeChild(row))
    let previous: Family | null = null
    for (const item of records) {
      const current = family(item.satellitePass.satellite)
      if (groupPrototype && current !== previous) {
        const group = groupPrototype.cloneNode(true) as XmlElement
        const paragraph = group.getElementsByTagNameNS(W, 'p').item(0)!
        setText(paragraph, current === 'GF' ? 'GF / Gaofen 系列' : `${current} 系列`)
        paragraph.getElementsByTagNameNS(W, 'pPr').item(0)!.appendChild(doc.createElementNS(W, 'w:keepNext'))
        table.appendChild(group)
        previous = current
      }
      table.appendChild(populateRow(prototype, item))
    }
    if (!records.length) {
      const note = children(body, 'p')[7].cloneNode(true) as XmlElement
      setText(note, index === 1 ? '未来7天暂无同时满足天气和耀光条件的“推荐”窗口，请结合全部联合判断选择备选窗口。' : '当前水库和卫星筛选下没有完整覆盖窗口。')
      body.replaceChild(note, table)
    }
  }
  zip.file('word/document.xml', new XMLSerializer().serializeToString(doc))
  const bytes = await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' })
  return new Blob([bytes], { type: MIME })
}

export function observationPlanFileName(reservoirName: string, generatedAt = new Date()) {
  const date = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Shanghai',
  }).format(generatedAt).replaceAll('/', '')
  const safeName = reservoirName.replace(/[\\/:*?"<>|]+/g, '_').trim().replace(/[ ._]+$/g, '') || '水库'
  return `${safeName}_遥感观测实验计划_${date}.docx`
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
