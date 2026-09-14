import JSZip from 'jszip'
import { DOMParser, XMLSerializer, type Element as XmlElement } from '@xmldom/xmldom'
import templateUrl from '../assets/observation-plan-template.docx?url'
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
}

export interface AllReservoirReportRecord {
  family: Family
  reservoir: ReservoirProperties
  satellitePass: SatellitePass
  weather: string
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
    if (!reservoir || !weatherDay) continue
    const key = `${pass.reservoir_id}|${pass.date}|${pass.satellite}`
    if (!records.has(key)) records.set(key, {
      family: family(pass.satellite), reservoir, satellitePass: pass,
      weather: `白天${weatherDay.dayCondition} / 夜间${weatherDay.nightCondition}`,
    })
  }
  return [...records.values()].sort((a, b) => FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family)
    || a.satellitePass.date.localeCompare(b.satellitePass.date)
    || a.reservoir.name_cn.localeCompare(b.reservoir.name_cn, 'zh-CN')
    || a.satellitePass.satellite.localeCompare(b.satellitePass.satellite, 'zh-CN', { numeric: true }))
}

function append(parent: XmlElement, name: string, attrs: Record<string, string> = {}) {
  const node = parent.ownerDocument!.createElementNS(W, `w:${name}`)
  for (const [key, value] of Object.entries(attrs)) node.setAttributeNS(W, `w:${key}`, value)
  parent.appendChild(node)
  return node
}

function paragraph(parent: XmlElement, value: string, options: { bold?: boolean, size?: number, color?: string, after?: number, keepNext?: boolean } = {}) {
  const p = append(parent, 'p')
  const pPr = append(p, 'pPr')
  if (options.after !== undefined) append(pPr, 'spacing', { after: String(options.after) })
  if (options.keepNext) append(pPr, 'keepNext')
  const run = append(p, 'r')
  const rPr = append(run, 'rPr')
  append(rPr, 'rFonts', { ascii: 'Arial', hAnsi: 'Arial', eastAsia: 'Microsoft YaHei' })
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
  paragraph(cell, value, { bold: header, size: 19, after: 0 })
}

function reportTable(parent: XmlElement, records: AllReservoirReportRecord[]) {
  const table = append(parent, 'tbl')
  const props = append(table, 'tblPr')
  append(props, 'tblW', { w: '8800', type: 'dxa' })
  append(props, 'tblLayout', { type: 'fixed' })
  const borders = append(props, 'tblBorders')
  for (const name of ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']) append(borders, name, { val: 'single', sz: '4', color: 'A8C5C1' })
  const widths = [1900, 1700, 2400, 2800]
  const header = append(table, 'tr')
  const headerPr = append(header, 'trPr'); append(headerPr, 'tblHeader')
  ;['水库', '日期', '过境卫星', '天气状况'].forEach((value, index) => tableCell(header, value, widths[index], true))
  for (const record of records) {
    const row = append(table, 'tr')
    const rowPr = append(row, 'trPr'); append(rowPr, 'cantSplit')
    ;[record.reservoir.name_cn, record.satellitePass.date, record.satellitePass.satellite, record.weather]
      .forEach((value, index) => tableCell(row, value, widths[index]))
  }
  return table
}

function timestamp(value: Date) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hour12: false, timeZone: 'Asia/Shanghai',
  }).format(value)
}

export async function createAllReservoirReportBlob(data: AllReservoirReportData) {
  const response = await fetch(templateUrl)
  if (!response.ok) throw new Error('实验方案模板加载失败，请重试')
  const zip = await JSZip.loadAsync(await response.arrayBuffer())
  const doc = new DOMParser().parseFromString(await zip.file('word/document.xml')!.async('string'), 'application/xml')
  const body = doc.getElementsByTagNameNS(W, 'body').item(0)!
  const sectionProps = Array.from(body.childNodes).find((node) => node.nodeType === 1 && node.localName === 'sectPr')
  for (const child of Array.from(body.childNodes)) body.removeChild(child)

  const records = buildAllReservoirReportRecords(data)
  const coveredReservoirs = new Set(records.map((item) => item.reservoir.id)).size
  paragraph(body, '河南省水库未来7天完整覆盖实验方案简报', { bold: true, size: 34, color: '0F766E', after: 160 })
  paragraph(body, `生成时间：${timestamp(data.generatedAt ?? new Date())}（北京时间）`, { size: 19, color: '64748B', after: 80 })
  paragraph(body, `共汇总 ${coveredReservoirs} 座水库、${records.length} 条可获取的完整覆盖记录；天气获取成功 ${Object.keys(data.weatherByReservoir).length}/${data.reservoirs.length} 座水库。`, { size: 20, after: 160 })

  for (const group of FAMILY_ORDER) {
    const groupRecords = records.filter((item) => item.family === group)
    paragraph(body, group === 'GF' ? 'GF / Gaofen 系列' : `${group} 系列`, { bold: true, size: 26, color: '0F766E', after: 80, keepNext: true })
    if (groupRecords.length) reportTable(body, groupRecords)
    else paragraph(body, '未来7天暂无可获取的完整覆盖记录。', { size: 19, color: '64748B', after: 120 })
    paragraph(body, '', { size: 10, after: 80 })
  }
  paragraph(body, '说明：仅列出与已获取7天天气日期相匹配的完整水库覆盖窗口；卫星顺序为 Sentinel、HJ、Landsat、GF。', { size: 18, color: '64748B', after: 0 })
  if (sectionProps) body.appendChild(sectionProps)
  zip.file('word/document.xml', new XMLSerializer().serializeToString(doc))
  const bytes = await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' })
  return new Blob([bytes], { type: MIME })
}

export function allReservoirReportFileName(generatedAt = new Date()) {
  const date = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Shanghai',
  }).format(generatedAt).replaceAll('/', '')
  return `全部水库_未来7天完整覆盖实验方案简报_${date}.docx`
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
