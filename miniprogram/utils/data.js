const reservoirs = require('../data/reservoirs')
const { BASINS, getBasin } = require('../data/basins')
const network = require('./network')
const { buildExperimentRecommendation } = require('./recommendation')
const { isSupportedObservationPass, normalizeObservationPass } = require('./satellite')
const GLINT_LABELS = { high: '高', medium: '中', low: '低', minimal: '极低' }
const meta = { orbitGeneratedAt: '', orbitStartDate: '', orbitEndDate: '', weatherGeneratedAt: '',
  orbitError: '', weatherError: '', orbitStale: false, weatherStale: false, loadedAt: 0 }
let passes = [], weatherById = {}, pending = null

function beijingDay() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10) }
function beijingDate(value) { return new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 10) }
function withBasin(item) {
  const basin = item && getBasin(item.id)
  return item && basin ? { ...item, basin: basin.name, basinShortName: basin.shortName, basinColor: basin.color } : item
}
function getReservoir(id) { return withBasin(reservoirs.find((item) => item.id === id) || null) }
function getReservoirList() {
  return reservoirs.map(({ rings, polygons, shore_candidates, ...item }) => withBasin(item))
}
function getBasins() { return BASINS.map(({ ids, ...basin }) => ({ ...basin, count: ids.length })) }
function satelliteFamily(name) {
  if (name.startsWith('Sentinel')) return 'Sentinel'
  if (name.startsWith('HJ')) return 'HJ'
  if (name.startsWith('Landsat')) return 'Landsat'
  return 'GF'
}
function satelliteOrder(name) { return ['Sentinel', 'HJ', 'Landsat', 'GF'].indexOf(satelliteFamily(name)) }
function dateLabel(date) {
  return `${date.slice(5).replace('-', '/')} ${weekdayLabel(date)}`
}
function fullDateLabel(date) {
  const [year, month, day] = date.split('-').map(Number)
  return `${year}年${month}月${day}日`
}
function weekdayLabel(date) {
  const weekday = ['日', '一', '二', '三', '四', '五', '六'][new Date(`${date}T12:00:00+08:00`).getUTCDay()]
  return `周${weekday}`
}
function weatherSymbol(condition) {
  if (/雷/.test(condition)) return 'ϟ'
  if (/雪|冰雹/.test(condition)) return '❄'
  if (/雨/.test(condition)) return '☂'
  if (/雾|霾|沙/.test(condition)) return '≋'
  if (/阴/.test(condition)) return '☁'
  if (/多云/.test(condition)) return '⛅'
  if (/晴/.test(condition)) return '☀'
  return '◌'
}
function validWeather(value) {
  return value && value.source === '中央气象台' && typeof value.fetchedAt === 'string' && Number.isFinite(Date.parse(value.fetchedAt)) &&
    typeof value.stationName === 'string' && typeof value.sourceUrl === 'string' &&
    Array.isArray(value.days) && value.days.length === 7 && value.days.every((d) =>
      /^\d{4}-\d{2}-\d{2}$/.test(d?.date) && typeof d.dayCondition === 'string' && typeof d.nightCondition === 'string')
}
function reset() {
  passes = []; weatherById = {}
  Object.assign(meta, { orbitGeneratedAt: '', orbitStartDate: '', orbitEndDate: '', weatherGeneratedAt: '',
    orbitError: '', weatherError: '', orbitStale: false, weatherStale: false, loadedAt: 0 })
}
function hasRecentData() {
  return meta.loadedAt > Date.now() - 300000 && !meta.orbitError && !meta.weatherError
}
async function refresh(force = false) {
  if (pending) return pending
  if (!force && hasRecentData()) return meta
  pending = (async () => {
    const [orbit, weather] = await Promise.allSettled([
      network.getOrbits(), network.getWeather(),
    ])
    const today = beijingDay()
    try {
      if (orbit.status === 'rejected') throw orbit.reason
      const body = orbit.value
      if (body?.pipeline !== 'miniprogram-static-independent-v1' || body.schema_version !== 'static-observation-v2' || !Number.isFinite(Date.parse(body.generated_at)) ||
          !Array.isArray(body.items) || !body.items.length || !body.items.every((p) =>
            typeof p.id === 'string' && getReservoir(p.reservoir_id) && typeof p.satellite === 'string' &&
            typeof p.sensor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.date) &&
            Number.isFinite(Date.parse(p.time_utc)) && Number.isFinite(p.coverage) &&
            Number.isFinite(p.glint_angle_deg) && Object.prototype.hasOwnProperty.call(GLINT_LABELS, p.glint_risk))) {
        throw new Error('独立轨道数据格式不完整')
      }
      passes = body.items.map(normalizeObservationPass).filter((p) => isSupportedObservationPass(p) && p.coverage >= 99.9)
        .sort((a, b) => a.time_utc.localeCompare(b.time_utc))
      const dates = passes.map((p) => p.date).sort()
      Object.assign(meta, { orbitGeneratedAt: body.generated_at, orbitStartDate: dates[0] || '',
        orbitEndDate: dates[dates.length - 1] || '', orbitStale: beijingDate(body.generated_at) < today, orbitError: '' })
    } catch (error) {
      passes = []; Object.assign(meta, { orbitGeneratedAt: '', orbitStartDate: '', orbitEndDate: '', orbitError: error.message, orbitStale: false })
    }
    try {
      if (weather.status === 'rejected') throw weather.reason
      const body = weather.value
      if (body?.pipeline !== 'miniprogram-static-independent-v1' || body.source !== '中央气象台' || !body.items || !Number.isFinite(Date.parse(body.generatedAt))) throw new Error('独立天气数据格式不完整')
      weatherById = Object.fromEntries(Object.entries(body.items).filter(([id, value]) => getReservoir(id) && validWeather(value)))
      if (!Object.keys(weatherById).length) throw new Error('云端天气缓存尚未就绪')
      Object.assign(meta, { weatherGeneratedAt: body.generatedAt, weatherError: '',
        weatherStale: Object.values(weatherById).some((w) => w.cacheStatus === 'cloud-stale-fallback' || beijingDate(w.fetchedAt) < today) })
    } catch (error) {
      weatherById = {}; Object.assign(meta, { weatherGeneratedAt: '', weatherError: error.message, weatherStale: false })
    }
    meta.loadedAt = Date.now()
    return meta
  })()
  try { return await pending } finally { pending = null }
}
function getWeather(id) { return weatherById[id] || null }
function getWeatherCards(id) {
  return (getWeather(id)?.days || []).map((day) => ({ ...day, label: dateLabel(day.date),
    symbol: weatherSymbol(day.dayCondition), sunny: day.dayCondition.trim() === '晴' }))
}
function decoratePass(pass) {
  const weather = getWeather(pass.reservoir_id)
  const recommendation = buildExperimentRecommendation(pass, weather)
  return { ...pass, dateLabel: dateLabel(pass.date), fullDateLabel: fullDateLabel(pass.date), weekdayLabel: weekdayLabel(pass.date),
    glintLabel: GLINT_LABELS[pass.glint_risk],
    glintAngle: pass.glint_angle_deg.toFixed(1), level: recommendation.level,
    levelTone: recommendation.level === '推荐' ? 'sunny' : recommendation.level === '待预报' ? 'pending' : 'no',
    score: recommendation.score === null ? '—' : recommendation.score,
    weatherLabel: recommendation.weatherDay?.dayCondition || (weather ? '待预报' : '天气未获取'),
    reasons: weather ? recommendation.reasons : ['天气尚未获取，暂不能判断晴天实验条件', ...recommendation.reasons.slice(1)],
    reservoirName: getReservoir(pass.reservoir_id).name_cn, family: satelliteFamily(pass.satellite) }
}
function getPass(id) { const pass = passes.find((p) => p.id === id); return pass ? decoratePass(pass) : null }
function getPasses(id, satellite = '全部卫星') {
  return passes.filter((p) => p.reservoir_id === id && (satellite === '全部卫星' || p.satellite === satellite)).map(decoratePass)
}
function getSatelliteOptions(id) {
  const names = [...new Set(passes.filter((p) => p.reservoir_id === id).map((p) => p.satellite))]
  return ['全部卫星', ...names.sort((a, b) => satelliteOrder(a) - satelliteOrder(b) || a.localeCompare(b))]
}
function getBestPasses(id, satellite = '全部卫星') {
  return getPasses(id, satellite).filter((p) => p.level === '推荐')
    .sort((a, b) => b.score - a.score || a.time_utc.localeCompare(b.time_utc)).slice(0, 4)
}
function getPlanGroups(id) {
  const unique = new Map()
  for (const pass of id ? getPasses(id) : passes.map(decoratePass)) {
    if (pass.level === '推荐') {
      const key = `${pass.reservoir_id}|${pass.date}|${pass.satellite}`
      if (!unique.has(key)) unique.set(key, pass)
    }
  }
  return ['Sentinel', 'HJ', 'Landsat', 'GF'].map((family) => ({ name: family === 'GF' ? 'GF / Gaofen' : family,
    records: [...unique.values()].filter((p) => p.family === family)
      .sort((a, b) => a.time_utc.localeCompare(b.time_utc) || a.reservoir_id.localeCompare(b.reservoir_id)) }))
}
function buildPlanText(id) {
  const lines = [`${id ? getReservoir(id).name_cn : `全部${reservoirs.length}座水库`} · 晴天实验方案`,
    `轨道生成时间：${meta.orbitGeneratedAt || '未获取'}`, `天气来源：中央气象台；独立数据批次：${meta.weatherGeneratedAt || '未获取'}`,
    meta.orbitStale ? '提示：云端轨道不是今日更新，请核验数据时间。' : '',
    meta.weatherStale ? '提示：部分天气为旧缓存，请核验各站更新时间。' : '',
    meta.orbitError, meta.weatherError].filter(Boolean)
  for (const group of getPlanGroups(id)) {
    lines.push('', `${group.name} 系列`)
    if (!group.records.length) lines.push('暂无符合条件的晴天完整覆盖窗口。')
    for (const p of group.records) lines.push(`${p.date} ${p.time}（北京时间）｜${p.reservoirName}｜${p.satellite}｜白天晴｜耀光${p.glintLabel} ${p.glintAngle}°`)
  }
  lines.push('', '天气与轨道来自小程序独立数据；白天天气严格为“晴”，耀光风险单独提示。',
    '过境是几何覆盖预测，不代表已安排成像。出发前请核验站点预报与轨道生成时间。')
  return lines.join('\n')
}
// Coordinate conversion only creates map display copies; source geometry remains WGS84.
const PI = Math.PI, A = 6378245, EE = 0.006693421622965943
function wgs84ToGcj02(longitude, latitude) {
  if (longitude < 72.004 || longitude > 137.8347 || latitude < 0.8293 || latitude > 55.8271) return { longitude, latitude }
  const x = longitude - 105, y = latitude - 35
  const wave = 2 / 3 * (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI))
  let latOffset = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x)) + wave
  latOffset += 2 / 3 * (20 * Math.sin(y * PI) + 40 * Math.sin(y / 3 * PI))
  latOffset += 2 / 3 * (160 * Math.sin(y / 12 * PI) + 320 * Math.sin(y * PI / 30))
  let lonOffset = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x)) + wave
  lonOffset += 2 / 3 * (20 * Math.sin(x * PI) + 40 * Math.sin(x / 3 * PI))
  lonOffset += 2 / 3 * (150 * Math.sin(x / 12 * PI) + 300 * Math.sin(x / 30 * PI))
  const radians = latitude / 180 * PI, sin = Math.sin(radians), magic = 1 - EE * sin * sin
  return {
    longitude: longitude + lonOffset * 180 / (A / Math.sqrt(magic) * Math.cos(radians) * PI),
    latitude: latitude + latOffset * 180 / (A * (1 - EE) / magic ** 1.5 * PI),
  }
}
function bounds(points) {
  if (!points.length) return []
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity
  for (const { longitude, latitude } of points) {
    west = Math.min(west, longitude); east = Math.max(east, longitude)
    south = Math.min(south, latitude); north = Math.max(north, latitude)
  }
  return [{ longitude: west, latitude: south }, { longitude: east, latitude: north }]
}
function buildNativeMapData(map) {
  const markerIds = {}, markerBasins = {}
  const markers = map.markers.map((marker, index) => {
    const selected = marker.id === map.selectedId, id = index + 1
    markerIds[id] = marker.id
    markerBasins[id] = marker.basin
    return { id, ...wgs84ToGcj02(marker.longitude, marker.latitude),
      iconPath: selected ? '/assets/marker-selected.png' : '/assets/marker.png',
      width: selected ? 30 : 22, height: selected ? 38 : 28,
      ...(selected ? { callout: { content: `${marker.name} · ${marker.basin}`, display: 'ALWAYS', padding: 6,
        fontSize: 12, color: '#2E3440', bgColor: '#ECEFF4', borderRadius: 4 } } : {}),
    }
  })
  const selected = markers.find((marker) => markerIds[marker.id] === map.selectedId)
  // Boundary coordinates only determine the camera framing; no vector overlay is rendered.
  const currentBounds = bounds(map.rings.flat().map(([lon, lat]) => wgs84ToGcj02(lon, lat)))
  return { markerIds, markerBasins, currentBounds, allBounds: bounds(markers),
    view: { longitude: selected.longitude, latitude: selected.latitude, scale: 9, markers } }
}
function getMapData(id) {
  const selected = getReservoir(id)
  return selected ? { selectedId: id, rings: selected.rings,
    markers: reservoirs.map((r) => { const basin = getBasin(r.id); return { id: r.id, longitude: r.lon, latitude: r.lat,
      name: r.name_cn, basin: basin.name } }) } : null
}
module.exports = { meta, refresh, reset, hasRecentData, getReservoir, getReservoirList, getWeather, getWeatherCards,
  getPass, getPasses, getBestPasses, getSatelliteOptions, getPlanGroups, buildPlanText, getBasins, getMapData, buildNativeMapData,
  wgs84ToGcj02 }
