import {
  AlignmentType,
  BorderStyle,
  Document as DocxDocument,
  Footer,
  Header,
  HeadingLevel,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from 'docx'
import type {
  ExperimentRecommendation,
  OrbitPassPayload,
  ReservoirProperties,
  WeatherResult,
} from '../types'
import type { ExperimentThresholds } from './recommendation'

export interface ObservationPlanDocumentData {
  reservoir: ReservoirProperties
  recommendations: ExperimentRecommendation[]
  bestRecommendations: ExperimentRecommendation[]
  thresholds: ExperimentThresholds
  satelliteFilter: string
  orbitPayload: OrbitPassPayload | null
  weather: WeatherResult | null
  generatedAt?: Date
}

const COLORS = {
  ink: '16384A',
  blue: '16697A',
  teal: '1B998B',
  muted: '607D8B',
  line: 'CAD9DE',
  headerFill: 'E8F2F4',
  softFill: 'F5F8F9',
  warningFill: 'FFF6DD',
  warning: '805B10',
  good: '13795B',
  medium: '9A6700',
  bad: 'B42318',
}

const FONT = 'Microsoft YaHei'
const PAGE_WIDTH_DXA = 9360
const TABLE_INDENT_DXA = 120
const CELL_MARGINS = { top: 90, bottom: 90, left: 120, right: 120 }
const border = { style: BorderStyle.SINGLE, size: 4, color: COLORS.line }
const tableBorders = { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border }

function dateTimeZh(value: Date) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hour12: false, timeZone: 'Asia/Shanghai',
  }).format(value)
}

function sourceTimestamp(value?: string | null) {
  if (!value) return '暂无'
  return dateTimeZh(new Date(value))
}

function glintLabel(risk: ExperimentRecommendation['satellitePass']['glint_risk']) {
  return { high: '高', medium: '中', low: '低', minimal: '极低' }[risk]
}

function levelColor(level: ExperimentRecommendation['level']) {
  return { 推荐: COLORS.good, 备选: COLORS.medium, 不推荐: COLORS.bad, 待预报: COLORS.muted }[level]
}

function paragraph(text: string, options: { bold?: boolean; color?: string; size?: number; align?: typeof AlignmentType[keyof typeof AlignmentType] } = {}) {
  return new Paragraph({
    alignment: options.align,
    spacing: { after: 80, line: 276 },
    children: [new TextRun({ text, bold: options.bold, color: options.color ?? COLORS.ink, size: options.size ?? 20, font: FONT })],
  })
}

function cell(text: string, width: number, options: { header?: boolean; align?: typeof AlignmentType[keyof typeof AlignmentType]; color?: string; bold?: boolean } = {}) {
  const runs = text.split('\n').map((line, index) => new TextRun({
    text: line,
    break: index === 0 ? undefined : 1,
    font: FONT,
    size: options.header ? 18 : 17,
    bold: options.header || options.bold,
    color: options.color ?? COLORS.ink,
  }))
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    margins: CELL_MARGINS,
    verticalAlign: VerticalAlign.CENTER,
    shading: options.header ? { type: ShadingType.CLEAR, fill: COLORS.headerFill, color: 'auto' } : undefined,
    children: [new Paragraph({
      alignment: options.align ?? AlignmentType.LEFT,
      spacing: { before: 0, after: 0, line: 250 },
      children: runs,
    })],
  })
}

function table(rows: TableRow[], columnWidths: number[]) {
  return new Table({
    rows,
    width: { size: PAGE_WIDTH_DXA, type: WidthType.DXA },
    indent: { size: TABLE_INDENT_DXA, type: WidthType.DXA },
    columnWidths,
    layout: TableLayoutType.FIXED,
    borders: tableBorders,
    margins: CELL_MARGINS,
  })
}

function recommendationWeather(item: ExperimentRecommendation) {
  if (!item.weatherHour) return '天气尚未发布'
  return `云量 ${Math.round(item.weatherHour.cloudCover)}%\n降水 ${Math.round(item.weatherHour.precipitationProbability)}%\n风速 ${item.weatherHour.windSpeed.toFixed(1)} m/s`
}

const SATELLITE_FAMILY_ORDER = ['Sentinel', 'HJ', 'Landsat', 'GF'] as const
type SatelliteFamily = typeof SATELLITE_FAMILY_ORDER[number]

function satelliteFamily(satellite: string): SatelliteFamily {
  if (satellite.startsWith('Sentinel')) return 'Sentinel'
  if (satellite.startsWith('HJ')) return 'HJ'
  if (satellite.startsWith('Landsat')) return 'Landsat'
  return 'GF'
}

export function sortRecommendationsBySatelliteFamily(items: ExperimentRecommendation[]) {
  return [...items].sort((a, b) => {
    const familyDifference = SATELLITE_FAMILY_ORDER.indexOf(satelliteFamily(a.satellitePass.satellite))
      - SATELLITE_FAMILY_ORDER.indexOf(satelliteFamily(b.satellitePass.satellite))
    if (familyDifference) return familyDifference
    return a.satellitePass.satellite.localeCompare(b.satellitePass.satellite, 'zh-CN', { numeric: true })
      || a.satellitePass.date.localeCompare(b.satellitePass.date)
      || a.satellitePass.time.localeCompare(b.satellitePass.time)
  })
}

function createSummaryTable(data: ObservationPlanDocumentData) {
  const p = data.reservoir
  const widths = [1900, 2780, 1900, 2780]
  const rows = [
    ['水库', p.name_cn, '行政区', p.city],
    ['水库编号', p.code, '水面面积', `${p.area_km2.toFixed(2)} km²`],
    ['中心坐标', `${p.lon.toFixed(4)}, ${p.lat.toFixed(4)}`, '卫星筛选', data.satelliteFilter],
    ['天气阈值', `云量 ≤ ${data.thresholds.maxCloud}%\n降水概率 ≤ ${data.thresholds.maxRainProbability}%`, '风速阈值', `≤ ${data.thresholds.maxWind} m/s`],
  ]
  return table(rows.map((row) => new TableRow({
    cantSplit: true,
    children: [
      cell(row[0], widths[0], { header: true }), cell(row[1], widths[1]),
      cell(row[2], widths[2], { header: true }), cell(row[3], widths[3]),
    ],
  })), widths)
}

function createBestTable(items: ExperimentRecommendation[]) {
  const widths = [1700, 1900, 2560, 1400, 800, 1000]
  const header = new TableRow({
    tableHeader: true,
    cantSplit: true,
    children: ['日期时间', '卫星 / 传感器', '过境天气', '耀光风险', '评分', '结论']
      .map((value, index) => cell(value, widths[index], { header: true, align: AlignmentType.CENTER })),
  })
  const body = items.map((item) => new TableRow({
    cantSplit: true,
    children: [
      cell(`${item.satellitePass.date}\n${item.satellitePass.time}`, widths[0], { align: AlignmentType.CENTER }),
      cell(`${item.satellitePass.satellite}\n${item.satellitePass.sensor}`, widths[1]),
      cell(recommendationWeather(item), widths[2]),
      cell(`${glintLabel(item.satellitePass.glint_risk)}\n${item.satellitePass.glint_angle_deg.toFixed(1)}°`, widths[3], { align: AlignmentType.CENTER }),
      cell(item.score === null ? '—' : String(item.score), widths[4], { align: AlignmentType.CENTER, bold: true, color: levelColor(item.level) }),
      cell(item.level, widths[5], { align: AlignmentType.CENTER, bold: true, color: levelColor(item.level) }),
    ],
  }))
  return table([header, ...body], widths)
}

function createAllWindowsTable(items: ExperimentRecommendation[]) {
  const widths = [1700, 1900, 2560, 1400, 800, 1000]
  const header = new TableRow({
    tableHeader: true,
    cantSplit: true,
    children: ['日期时间', '卫星 / 传感器', '过境天气', '耀光风险', '评分', '判断']
      .map((value, index) => cell(value, widths[index], { header: true, align: AlignmentType.CENTER })),
  })
  const familyLabels: Record<SatelliteFamily, string> = {
    Sentinel: 'Sentinel 系列', HJ: 'HJ 系列', Landsat: 'Landsat 系列', GF: 'GF / Gaofen 系列',
  }
  const body: TableRow[] = []
  let currentFamily: SatelliteFamily | null = null
  for (const item of sortRecommendationsBySatelliteFamily(items)) {
    const family = satelliteFamily(item.satellitePass.satellite)
    if (family !== currentFamily) {
      currentFamily = family
      body.push(new TableRow({
        cantSplit: true,
        children: [new TableCell({
          columnSpan: widths.length,
          width: { size: PAGE_WIDTH_DXA, type: WidthType.DXA },
          margins: { top: 100, bottom: 100, left: 140, right: 140 },
          shading: { type: ShadingType.CLEAR, fill: COLORS.softFill, color: 'auto' },
          children: [paragraph(familyLabels[family], { bold: true, color: COLORS.blue, size: 18 })],
        })],
      }))
    }
    body.push(new TableRow({
      cantSplit: true,
      children: [
        cell(`${item.satellitePass.date}\n${item.satellitePass.time}`, widths[0], { align: AlignmentType.CENTER }),
        cell(`${item.satellitePass.satellite}\n${item.satellitePass.sensor}`, widths[1]),
        cell(recommendationWeather(item), widths[2]),
        cell(`${glintLabel(item.satellitePass.glint_risk)}\n${item.satellitePass.glint_angle_deg.toFixed(1)}°`, widths[3], { align: AlignmentType.CENTER }),
        cell(item.score === null ? '—' : String(item.score), widths[4], { align: AlignmentType.CENTER, bold: true, color: levelColor(item.level) }),
        cell(item.level, widths[5], { align: AlignmentType.CENTER, bold: true, color: levelColor(item.level) }),
      ],
    }))
  }
  return table([header, ...body], widths)
}

export function createObservationPlanDocument(data: ObservationPlanDocumentData) {
  const generatedAt = data.generatedAt ?? new Date()
  const ranked = [...data.recommendations].sort((a, b) => {
    if (a.score === null && b.score === null) return a.satellitePass.date.localeCompare(b.satellitePass.date)
    if (a.score === null) return 1
    if (b.score === null) return -1
    return b.score - a.score || a.satellitePass.date.localeCompare(b.satellitePass.date)
  })
  const best = data.bestRecommendations.length ? data.bestRecommendations : ranked.filter((item) => item.level === '推荐').slice(0, 4)
  const bestSection = best.length
    ? [createBestTable(best)]
    : [paragraph('当前阈值和卫星筛选下暂无“推荐”窗口，请结合下表中的备选窗口调整实验计划。', { color: COLORS.warning })]

  const children = [
    new Paragraph({
      spacing: { before: 0, after: 80 },
      children: [new TextRun({ text: '星地同步实验助手', font: FONT, size: 18, bold: true, color: COLORS.teal, allCaps: true })],
    }),
    new Paragraph({
      spacing: { before: 0, after: 100 },
      children: [new TextRun({ text: `${data.reservoir.name_cn}遥感观测实验计划`, font: FONT, size: 42, bold: true, color: COLORS.ink })],
    }),
    paragraph(`生成时间：${dateTimeZh(generatedAt)}（北京时间）`, { color: COLORS.muted, size: 18 }),
    paragraph('用途：依据未来完整覆盖轨道窗口、逐小时天气预报与水面耀光几何风险，辅助安排现场同步实验。', { color: COLORS.muted, size: 18 }),
    new Paragraph({ spacing: { before: 100, after: 100 }, border: { bottom: { style: BorderStyle.SINGLE, size: 10, color: COLORS.teal } } }),
    new Paragraph({ text: '一、计划概览', heading: HeadingLevel.HEADING_1 }),
    createSummaryTable(data),
    new Paragraph({ text: '二、优先推荐窗口', heading: HeadingLevel.HEADING_1 }),
    ...bestSection,
    paragraph(`本次共纳入 ${data.recommendations.length} 个完整覆盖窗口，其中推荐 ${data.recommendations.filter((item) => item.level === '推荐').length} 个、备选 ${data.recommendations.filter((item) => item.level === '备选').length} 个、待预报 ${data.recommendations.filter((item) => item.level === '待预报').length} 个。`, { color: COLORS.muted, size: 18 }),
    new Paragraph({ text: '三、全部联合判断', heading: HeadingLevel.HEADING_1 }),
    ...(ranked.length ? [createAllWindowsTable(data.recommendations)] : [paragraph('当前水库和卫星筛选下没有完整覆盖窗口。', { color: COLORS.muted })]),
    new Paragraph({ text: '四、数据来源与使用说明', heading: HeadingLevel.HEADING_1 }),
    paragraph(`轨道数据：CelesTrak OMM / SGP4；静态数据生成时间 ${sourceTimestamp(data.orbitPayload?.generated_at)}；轨道历元 ${sourceTimestamp(data.orbitPayload?.element_epoch_latest)}。`),
    paragraph(`天气数据：${data.weather?.source ?? '天气尚未获取'}；天气更新时间 ${sourceTimestamp(data.weather?.fetchedAt)}。逐小时天气按过境时刻附近的预报匹配。`),
    new Table({
      rows: [new TableRow({ children: [new TableCell({
        width: { size: PAGE_WIDTH_DXA, type: WidthType.DXA },
        margins: { top: 150, bottom: 150, left: 180, right: 180 },
        shading: { type: ShadingType.CLEAR, fill: COLORS.warningFill, color: 'auto' },
        children: [paragraph('重要提示：窗口只表示轨道和传感器幅宽可完整覆盖水库，不代表卫星运营方已确认成像。耀光风险依据太阳—平静水面—卫星镜面反射几何估算，实际影像还会受到风浪、水面粗糙度、传感器姿态、临时云况和运营排程影响。出发前请再次核验最新天气与任务计划。', { color: COLORS.warning, size: 18 })],
      })] })],
      width: { size: PAGE_WIDTH_DXA, type: WidthType.DXA },
      indent: { size: TABLE_INDENT_DXA, type: WidthType.DXA },
      columnWidths: [PAGE_WIDTH_DXA],
      layout: TableLayoutType.FIXED,
      borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
    }),
  ]

  return new DocxDocument({
    creator: '星地同步实验助手',
    title: `${data.reservoir.name_cn}遥感观测实验计划`,
    description: '水库遥感观测实验日期、天气与卫星轨道联合判断',
    styles: {
      default: {
        document: {
          run: { font: FONT, size: 20, color: COLORS.ink },
          paragraph: { spacing: { before: 0, after: 120, line: 276 } },
        },
        heading1: {
          run: { font: FONT, size: 30, bold: true, color: COLORS.blue },
          paragraph: { spacing: { before: 300, after: 140 }, keepNext: true },
        },
        heading2: {
          run: { font: FONT, size: 24, bold: true, color: COLORS.blue },
          paragraph: { spacing: { before: 220, after: 120 }, keepNext: true },
        },
      },
    },
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 1080, right: 1440, bottom: 1080, left: 1440, header: 600, footer: 600 },
        },
      },
      headers: { default: new Header({ children: [paragraph('河南省省控水库遥感观测实验计划', { color: COLORS.muted, size: 16 })] }) },
      footers: { default: new Footer({ children: [new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [new TextRun({ children: ['第 ', PageNumber.CURRENT, ' 页'], font: FONT, size: 16, color: COLORS.muted })],
      })] }) },
      children,
    }],
  })
}

export async function createObservationPlanBlob(data: ObservationPlanDocumentData) {
  return Packer.toBlob(createObservationPlanDocument(data))
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
