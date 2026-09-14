import JSZip from 'jszip'
import { DOMParser, XMLSerializer, type Element as XmlElement } from '@xmldom/xmldom'
import templateUrl from '../assets/observation-plan-template.docx?inline'
import type { OrbitPassPayload, ReservoirProperties, SatellitePass, WeatherResult } from '../types'
import { isSupportedObservationPass } from './satellite'

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const FAMILY_ORDER = ['Sentinel', 'HJ', 'Landsat', 'GF'] as const
type Family = typeof FAMILY_ORDER[number]

export interface AllReservoirReportData {
  reservoirs: ReservoirProperties[]
  orbitPayload: OrbitPassPayload
  weatherByReservoir: Record<string, WeatherResult>
  failedReservoirIds?: string[]
  generatedAt?: Date
  reportTitle?: string
}

export interface AllReservoirReportRecord {
  family: Family
  reservoir: ReservoirProperties
  satellitePass: SatellitePass
  weather: string
}

export interface UnavailableReservoirRecord {
  reservoir: ReservoirProperties
  reason: string
}

export function isSunnyWeather(condition: string) {
  return condition.trim() === '晴'
}

function family(satellite: string): Family {
  if (satellite.startsWith('Sentinel')) return 'Sentinel'
  if (satellite.startsWith('HJ')) return 'HJ'
  if (satellite.startsWith('Landsat')) return 'Landsat'
  return 'GF'
}

export function buildAllReservoirReportRecords(data: AllReservoirReportData) {
  const reservoirById = new Map(data.reservoirs.map((item) => [item.id, item]))
  const records = new Map<string, AllReservoirReportRecord>()
  for (const pass of data.orbitPayload.items) {
    if (!isSupportedObservationPass(pass)) continue
    const reservoir = reservoirById.get(pass.reservoir_id)
    const weatherDay = data.weatherByReservoir[pass.reservoir_id]?.days.find((day) => day.date === pass.date)
    if (!reservoir || !weatherDay || !isSunnyWeather(weatherDay.dayCondition)) continue
    const key = `${pass.reservoir_id}|${pass.date}|${pass.satellite}`
    if (!records.has(key)) records.set(key, {
      family: family(pass.satellite), reservoir, satellitePass: pass,
      weather: '晴',
    })
  }
  return [...records.values()].sort((a, b) => FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family)
    || a.satellitePass.date.localeCompare(b.satellitePass.date)
    || a.reservoir.name_cn.localeCompare(b.reservoir.name_cn, 'zh-CN')
    || a.satellitePass.satellite.localeCompare(b.satellitePass.satellite, 'zh-CN', { numeric: true }))
}

export function buildUnavailableReservoirRecords(data: AllReservoirReportData): UnavailableReservoirRecord[] {
  const passesByReservoir = new Map<string, SatellitePass[]>()
  for (const pass of data.orbitPayload.items.filter(isSupportedObservationPass)) {
    const existing = passesByReservoir.get(pass.reservoir_id) ?? []
    existing.push(pass)
    passesByReservoir.set(pass.reservoir_id, existing)
  }
  const sunnyReservoirs = new Set(buildAllReservoirReportRecords(data).map((item) => item.reservoir.id))
  return data.reservoirs.filter((reservoir) => !sunnyReservoirs.has(reservoir.id)).map((reservoir) => {
    const weather = data.weatherByReservoir[reservoir.id]
    if (!weather) return { reservoir, reason: '天气数据未获取，暂不能判定' }
    const weatherByDate = new Map(weather.days.map((day) => [day.date, day.dayCondition]))
    const matchingPasses = (passesByReservoir.get(reservoir.id) ?? []).filter((pass) => weatherByDate.has(pass.date))
    if (!matchingPasses.length) return { reservoir, reason: '未来7天无完整覆盖过境窗口' }
    const conditions = [...new Set(matchingPasses.map((pass) => weatherByDate.get(pass.date)!))]
    return { reservoir, reason: `过境日期白天天气不符（${conditions.join('、')}）` }
  })
}

function append(parent: XmlElement, name: string, attrs: Record<string, string> = {}) {
  const node = parent.ownerDocument!.createElementNS(W, `w:${name}`)
  for (const [key, value] of Object.entries(attrs)) node.setAttributeNS(W, `w:${key}`, value)
  parent.appendChild(node)
  return node
}

function paragraph(parent: XmlElement, value: string, options: { bold?: boolean, size?: number, color?: string, after?: number, keepNext?: boolean, align?: 'left' | 'center' | 'right' } = {}) {
  const p = append(parent, 'p')
  const pPr = append(p, 'pPr')
  if (options.after !== undefined) append(pPr, 'spacing', { after: String(options.after) })
  if (options.keepNext) append(pPr, 'keepNext')
  if (options.align) append(pPr, 'jc', { val: options.align })
  const run = append(p, 'r')
  const rPr = append(run, 'rPr')
  append(rPr, 'rFonts', { ascii: 'Times New Roman', hAnsi: 'Times New Roman', cs: 'Times New Roman', eastAsia: '宋体' })
  if (options.bold) append(rPr, 'b')
  if (options.size) { append(rPr, 'sz', { val: String(options.size) }); append(rPr, 'szCs', { val: String(options.size) }) }
  if (options.color) append(rPr, 'color', { val: options.color })
  const text = append(run, 't')
  text.setAttribute('xml:space', 'preserve')
  text.appendChild(parent.ownerDocument!.createTextNode(value))
  return p
}

function tableCell(row: XmlElement, value: string, width: number, header = false) {
  const cell = append(row, 'tc')
  const cellPr = append(cell, 'tcPr')
  append(cellPr, 'tcW', { w: String(width), type: 'dxa' })
  append(cellPr, 'vAlign', { val: 'center' })
  if (header) append(cellPr, 'shd', { fill: 'D9EDE9' })
  paragraph(cell, value, { bold: header, size: 19, after: 0, align: 'center' })
}

function reportTable(parent: XmlElement, records: AllReservoirReportRecord[]) {
  const table = append(parent, 'tbl')
  const props = append(table, 'tblPr')
  append(props, 'tblW', { w: '8800', type: 'dxa' })
  append(props, 'jc', { val: 'center' })
  append(props, 'tblLayout', { type: 'fixed' })
  const borders = append(props, 'tblBorders')
  for (const name of ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']) append(borders, name, { val: 'single', sz: '4', color: 'A8C5C1' })
  const widths = [1900, 1700, 2400, 2800]
  const header = append(table, 'tr')
  const headerPr = append(header, 'trPr'); append(headerPr, 'tblHeader')
  ;['水库', '日期', '过境卫星', '白天天气'].forEach((value, index) => tableCell(header, value, widths[index], true))
  for (const record of records) {
    const row = append(table, 'tr')
    const rowPr = append(row, 'trPr'); append(rowPr, 'cantSplit')
    ;[record.reservoir.name_cn, record.satellitePass.date, record.satellitePass.satellite, record.weather]
      .forEach((value, index) => tableCell(row, value, widths[index]))
  }
  return table
}

function unavailableTable(parent: XmlElement, records: UnavailableReservoirRecord[]) {
  const table = append(parent, 'tbl')
  const props = append(table, 'tblPr')
  append(props, 'tblW', { w: '8800', type: 'dxa' })
  append(props, 'jc', { val: 'center' })
  append(props, 'tblLayout', { type: 'fixed' })
  const borders = append(props, 'tblBorders')
  for (const name of ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']) append(borders, name, { val: 'single', sz: '4', color: 'A8C5C1' })
  const header = append(table, 'tr'); const headerPr = append(header, 'trPr'); append(headerPr, 'tblHeader')
  tableCell(header, '水库', 2600, true); tableCell(header, '情况说明', 6200, true)
  for (const record of records) {
    const row = append(table, 'tr'); const rowPr = append(row, 'trPr'); append(rowPr, 'cantSplit')
    tableCell(row, record.reservoir.name_cn, 2600); tableCell(row, record.reason, 6200)
  }
}

function timestamp(value: Date) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hour12: false, timeZone: 'Asia/Shanghai',
  }).format(value)
}

async function loadTemplateBytes() {
  if (templateUrl.startsWith('data:')) {
    const comma = templateUrl.indexOf(',')
    if (comma < 0) throw new Error('实验方案模板数据无效')
    const metadata = templateUrl.slice(0, comma)
    const payload = templateUrl.slice(comma + 1)
    if (metadata.endsWith(';base64')) {
      const binary = atob(payload)
      return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer
    }
    return new TextEncoder().encode(decodeURIComponent(payload)).buffer
  }
  const response = await fetch(templateUrl)
  if (!response.ok) throw new Error('实验方案模板加载失败，请重试')
  return response.arrayBuffer()
}

export async function createAllReservoirReportBlob(data: AllReservoirReportData) {
  const zip = await JSZip.loadAsync(await loadTemplateBytes())
  const doc = new DOMParser().parseFromString(await zip.file('word/document.xml')!.async('string'), 'application/xml')
  const body = doc.getElementsByTagNameNS(W, 'body').item(0)!
  const sectionProps = Array.from(body.childNodes).find((node) => node.nodeType === 1 && node.localName === 'sectPr')
  for (const child of Array.from(body.childNodes)) body.removeChild(child)

  const records = buildAllReservoirReportRecords(data)
  const coveredReservoirs = new Set(records.map((item) => item.reservoir.id)).size
  paragraph(body, data.reportTitle ?? '河南省水库未来7天晴天实验方案简报', { bold: true, size: 34, color: '0F766E', after: 160 })
  paragraph(body, `生成时间：${timestamp(data.generatedAt ?? new Date())}（北京时间）`, { size: 19, color: '64748B', after: 80 })
  paragraph(body, `按卫星过境日期匹配当天白天天气，仅保留“晴”的实验窗口。共形成 ${coveredReservoirs} 座水库、${records.length} 条晴天完整覆盖记录。`, { size: 20, after: 160 })

  for (const group of FAMILY_ORDER) {
    const groupRecords = records.filter((item) => item.family === group)
    paragraph(body, group === 'GF' ? 'GF / Gaofen 系列' : `${group} 系列`, { bold: true, size: 26, color: '0F766E', after: 80, keepNext: true })
    if (groupRecords.length) reportTable(body, groupRecords)
    else {
      const passes = data.orbitPayload.items.filter((pass) => isSupportedObservationPass(pass) && family(pass.satellite) === group)
      const hasForecastPass = passes.some((pass) => data.weatherByReservoir[pass.reservoir_id]?.days.some((day) => day.date === pass.date))
      paragraph(body, hasForecastPass
        ? '完整覆盖过境日期的白天天气均非晴，不符合实验出差条件。'
        : '未来7天无可判定的完整覆盖过境窗口。', { size: 19, color: '64748B', after: 120 })
    }
    paragraph(body, '', { size: 10, after: 80 })
  }
  const unavailable = buildUnavailableReservoirRecords(data)
  if (unavailable.length) {
    paragraph(body, '未形成晴天实验安排的水库', { bold: true, size: 26, color: '0F766E', after: 80, keepNext: true })
    unavailableTable(body, unavailable)
    paragraph(body, '', { size: 10, after: 80 })
  }
  paragraph(body, '说明：轨道窗口先按日期匹配中央气象台7天预报，再严格筛选白天天气为“晴”的记录；卫星顺序为 Sentinel、HJ、Landsat、GF。', { size: 18, color: '64748B', after: 0 })
  if (sectionProps) body.appendChild(sectionProps)
  zip.file('word/document.xml', new XMLSerializer().serializeToString(doc))
  const bytes = await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' })
  return new Blob([bytes], { type: MIME })
}

export function allReservoirReportFileName(generatedAt = new Date()) {
  const date = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Shanghai',
  }).format(generatedAt).replaceAll('/', '')
  return `全部水库_未来7天晴天实验方案简报_${date}.docx`
}

export async function downloadAllReservoirReport(data: AllReservoirReportData) {
  const blob = await createAllReservoirReportBlob(data)
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = allReservoirReportFileName(data.generatedAt)
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
