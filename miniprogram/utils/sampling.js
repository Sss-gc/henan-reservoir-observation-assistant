const referenceLayouts = require('../data/sampling-reference')

const REFERENCE_COUNTS = Object.fromEntries(Object.entries(referenceLayouts)
  .map(([id, reference]) => [id, reference.points.length]))
const MAX_POINT_COUNT = 50
const MIN_POINT_COUNT = 6

const SAMPLING_SCHEMES = [
  { id: 'sync', label: '星地同步', badge: '推荐', description: '参照既有点位的布局与分布规律' },
  { id: 'shore', label: '岸边加密', badge: '候选', description: '河南库区岸边可达候选 · 需现场复核', candidateMode: 'shore-access' },
]

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value))

function normalizeRing(ring) {
  const points = (ring || []).filter((point) => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]))
  if (points.length > 3) {
    const first = points[0], last = points[points.length - 1]
    if (first[0] === last[0] && first[1] === last[1]) return points.slice(0, -1)
  }
  return points
}

function ringArea(ring) {
  const points = normalizeRing(ring)
  if (points.length < 3) return 0
  const latitude = points.reduce((sum, point) => sum + point[1], 0) / points.length
  const lonScale = Math.cos(latitude * Math.PI / 180)
  let twiceArea = 0
  for (let index = 0; index < points.length; index++) {
    const current = points[index], next = points[(index + 1) % points.length]
    twiceArea += current[0] * lonScale * next[1] - next[0] * lonScale * current[1]
  }
  return Math.abs(twiceArea / 2)
}

function largestRing(rings) {
  return (rings || []).map(normalizeRing).filter((ring) => ring.length >= 3)
    .sort((left, right) => ringArea(right) - ringArea(left))[0] || []
}

function simplifyRing(ring, maximumVertices = 900) {
  if (ring.length <= maximumVertices) return ring
  const step = Math.ceil(ring.length / maximumVertices)
  const result = []
  for (let index = 0; index < ring.length; index += step) result.push(ring[index])
  return result
}

function pointInRing(point, ring) {
  let inside = false
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const xi = ring[index].x, yi = ring[index].y, xj = ring[previous].x, yj = ring[previous].y
    const crosses = (yi > point.y) !== (yj > point.y)
      && point.x < (xj - xi) * (point.y - yi) / ((yj - yi) || Number.EPSILON) + xi
    if (crosses) inside = !inside
  }
  return inside
}

function distanceToSegment(point, start, end) {
  const dx = end.x - start.x, dy = end.y - start.y
  if (!dx && !dy) return Math.hypot(point.x - start.x, point.y - start.y)
  const ratio = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy), 0, 1)
  return Math.hypot(point.x - start.x - ratio * dx, point.y - start.y - ratio * dy)
}

function distanceToRing(point, ring) {
  let result = Infinity
  for (let index = 0; index < ring.length; index++) {
    result = Math.min(result, distanceToSegment(point, ring[index], ring[(index + 1) % ring.length]))
  }
  return result
}

function createGeometry(reservoir) {
  const sourcePolygons = Array.isArray(reservoir.polygons) && reservoir.polygons.length
    ? reservoir.polygons
    : [[largestRing(reservoir.rings || [])]]
  const allCoordinates = sourcePolygons.flat(2).filter((point) => Array.isArray(point))
  if (allCoordinates.length < 3) throw new Error('该水库缺少可用的水面边界')
  const centerLatitude = allCoordinates.reduce((sum, point) => sum + point[1], 0) / allCoordinates.length
  const lonScale = 111.32 * Math.cos(centerLatitude * Math.PI / 180), latScale = 110.574
  const originLongitude = Math.min(...allCoordinates.map((point) => point[0]))
  const originLatitude = Math.min(...allCoordinates.map((point) => point[1]))
  const project = ([longitude, latitude]) => ({
    x: (longitude - originLongitude) * lonScale,
    y: (latitude - originLatitude) * latScale,
    longitude, latitude,
  })
  const unproject = ({ x, y }) => ({
    longitude: originLongitude + x / lonScale,
    latitude: originLatitude + y / latScale,
  })
  const polygons = sourcePolygons.map((sourcePolygon) => {
    const rings = sourcePolygon.map(normalizeRing).filter((ring) => ring.length >= 3)
    return {
      outer: simplifyRing(rings[0] || []).map(project),
      holes: rings.slice(1).map((ring) => simplifyRing(ring, 300).map(project)),
    }
  }).filter((polygon) => polygon.outer.length >= 3)
  if (!polygons.length) throw new Error('该水库缺少可用的水面边界')
  return { polygons, project, unproject }
}

function polygonForPoint(point, geometry) {
  return geometry.polygons.find((polygon) => pointInRing(point, polygon.outer)
    && !polygon.holes.some((hole) => pointInRing(point, hole))) || null
}

function pointInGeometry(point, geometry) { return Boolean(polygonForPoint(point, geometry)) }

function shoreDistanceInGeometry(point, geometry) {
  const polygon = polygonForPoint(point, geometry)
  if (!polygon) return 0
  return Math.min(distanceToRing(point, polygon.outer), ...polygon.holes.map((hole) => distanceToRing(point, hole)))
}

function preferredShoreBuffer(reservoir) {
  return clamp(Math.sqrt(Math.max(1, reservoir.area_km2 || 1)) / 35, 0.15, 0.55)
}

function buildCandidates(reservoir, geometry, count) {
  const outerPoints = geometry.polygons.flatMap((polygon) => polygon.outer)
  const xs = outerPoints.map((point) => point.x), ys = outerPoints.map((point) => point.y)
  const west = Math.min(...xs), east = Math.max(...xs), south = Math.min(...ys), north = Math.max(...ys)
  const width = east - west, height = north - south, maximum = Math.max(width, height)
  const columns = clamp(Math.round(68 * width / maximum), 24, 68)
  const rows = clamp(Math.round(68 * height / maximum), 24, 68)
  const inside = []
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const point = {
        x: west + (column + 0.5 + (row % 2 ? 0.18 : -0.18)) * width / columns,
        y: south + (row + 0.5) * height / rows,
      }
      if (!pointInGeometry(point, geometry)) continue
      point.shoreDistance = shoreDistanceInGeometry(point, geometry)
      Object.assign(point, geometry.unproject(point))
      inside.push(point)
    }
  }
  if (inside.length < count) throw new Error('水面边界过窄，无法生成足够的候选点')
  const preferredBuffer = preferredShoreBuffer(reservoir)
  const distances = inside.map((point) => point.shoreDistance).sort((left, right) => right - left)
  const achievableBuffer = distances[Math.min(count - 1, distances.length - 1)] || 0
  const appliedBuffer = Math.min(preferredBuffer, achievableBuffer)
  return { points: inside.filter((point) => point.shoreDistance + 1e-9 >= appliedBuffer), preferredBuffer, appliedBuffer }
}

function buildShoreCandidates(reservoir, geometry, count) {
  const points = (reservoir.shore_candidates || []).map(([longitude, latitude]) => {
    const point = geometry.project([longitude, latitude])
    point.shoreDistance = shoreDistanceInGeometry(point, geometry)
    return point
  }).filter((point) => pointInGeometry(point, geometry) && point.shoreDistance >= 0.01 && point.shoreDistance <= 0.2)
  if (points.length < count) throw new Error('河南库区岸边候选点不足，请重新生成空间数据')
  return { points, preferredBuffer: 0.075, appliedBuffer: 0.075 }
}

function principalAxis(points) {
  const centerX = points.reduce((sum, point) => sum + point.x, 0) / points.length
  const centerY = points.reduce((sum, point) => sum + point.y, 0) / points.length
  let xx = 0, yy = 0, xy = 0
  for (const point of points) {
    const x = point.x - centerX, y = point.y - centerY
    xx += x * x; yy += y * y; xy += x * y
  }
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy)
  return { x: Math.cos(angle), y: Math.sin(angle), centerX, centerY }
}

function selectSpreadPoints(candidates, count, favorInterior = true) {
  const axis = principalAxis(candidates)
  const projection = (point) => (point.x - axis.centerX) * axis.x + (point.y - axis.centerY) * axis.y
  const maximumShoreDistance = Math.max(...candidates.map((point) => point.shoreDistance), 0.001)
  const selected = []
  const first = candidates.reduce((best, point) => projection(point) < projection(best) ? point : best, candidates[0])
  selected.push(first)
  const used = new Set([first])
  while (selected.length < count) {
    let best = null, bestScore = -1
    for (const candidate of candidates) {
      if (used.has(candidate)) continue
      const nearest = Math.min(...selected.map((point) => Math.hypot(candidate.x - point.x, candidate.y - point.y)))
      const weight = favorInterior ? 0.88 + 0.12 * candidate.shoreDistance / maximumShoreDistance : 1
      const score = nearest * weight
      if (score > bestScore) { best = candidate; bestScore = score }
    }
    if (!best) break
    used.add(best); selected.push(best)
  }
  const remaining = new Set(selected)
  const firstRoutePoint = selected.reduce((best, point) => projection(point) < projection(best) ? point : best, selected[0])
  const route = [firstRoutePoint]
  remaining.delete(firstRoutePoint)
  while (remaining.size) {
    const current = route[route.length - 1]
    let nearest = null, nearestDistance = Infinity
    for (const candidate of remaining) {
      const distance = Math.hypot(candidate.x - current.x, candidate.y - current.y)
      if (distance < nearestDistance) { nearest = candidate; nearestDistance = distance }
    }
    route.push(nearest); remaining.delete(nearest)
  }
  let improved = true
  while (improved) {
    improved = false
    for (let left = 1; left < route.length - 2; left++) {
      for (let right = left + 1; right < route.length - 1; right++) {
        const before = Math.hypot(route[left - 1].x - route[left].x, route[left - 1].y - route[left].y)
          + Math.hypot(route[right].x - route[right + 1].x, route[right].y - route[right + 1].y)
        const after = Math.hypot(route[left - 1].x - route[right].x, route[left - 1].y - route[right].y)
          + Math.hypot(route[left].x - route[right + 1].x, route[left].y - route[right + 1].y)
        if (after + 0.001 < before) {
          route.splice(left, right - left + 1, ...route.slice(left, right + 1).reverse())
          improved = true
        }
      }
    }
  }
  return route
}

function distanceKm(start, end) {
  const radius = 6371, lat1 = start.latitude * Math.PI / 180, lat2 = end.latitude * Math.PI / 180
  const dLat = lat2 - lat1, dLon = (end.longitude - start.longitude) * Math.PI / 180
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * radius * Math.asin(Math.sqrt(value))
}

function samplingPointDistanceM(start, end) {
  return Math.round(distanceKm(start, end) * 1000)
}

function samplingMetrics(points) {
  const distances = points.slice(1).map((point, index) => distanceKm(points[index], point))
  const routeDistanceKm = distances.reduce((sum, distance) => sum + distance, 0)
  return {
    routeDistanceKm: Number(routeDistanceKm.toFixed(1)),
    meanSpacingKm: Number((routeDistanceKm / Math.max(1, distances.length)).toFixed(1)),
    minimumSpacingKm: Number((distances.length ? Math.min(...distances) : 0).toFixed(1)),
    minimumShoreDistanceM: Math.round(Math.min(...points.map((point) => point.shoreDistanceKm)) * 1000),
  }
}

function scopedReferencePoints(reservoir, geometry = createGeometry(reservoir)) {
  const reference = referenceLayouts[reservoir.id]
  if (!reference) return []
  if ((reservoir.scope_retained_pct || 100) >= 99.95) return reference.points
  return reference.points.filter(({ longitude, latitude }) => pointInGeometry(geometry.project([longitude, latitude]), geometry))
}

function generatedSyncPointCount(reservoir) {
  return clamp(Math.round(7 + 2.25 * Math.log(Math.max(1, reservoir.area_km2 || 1) + 1)), 8, 25)
}

function defaultPointCount(reservoir) {
  const referenceCount = scopedReferencePoints(reservoir).length
  return referenceCount || generatedSyncPointCount(reservoir)
}

function standardPointCount(reservoir) { return defaultPointCount(reservoir) }

function shorePointCount(reservoir) {
  const area = Math.max(0, Number(reservoir.area_km2) || 0)
  if (area < 50) return 10
  if (area < 500) return 14
  if (area < 1000) return 19
  if (area < 2000) return 29
  return 49
}

function schemePointCount(reservoir, schemeId) {
  return schemeId === 'shore' ? shorePointCount(reservoir) : defaultPointCount(reservoir)
}

function getSamplingSchemes(reservoir) {
  return SAMPLING_SCHEMES.map((scheme) => ({ ...scheme, count: schemePointCount(reservoir, scheme.id), fixed: false }))
}

function buildSamplingPlan(reservoir, request) {
  const structuredRequest = request && typeof request === 'object'
  const schemeId = structuredRequest ? (request.schemeId || 'sync') : 'sync'
  const scheme = SAMPLING_SCHEMES.find((item) => item.id === schemeId) || SAMPLING_SCHEMES[0]
  const fallbackCount = schemePointCount(reservoir, scheme.id)
  const requestedCount = structuredRequest ? request.count : request
  const count = clamp(Math.round(Number(requestedCount) || fallbackCount), MIN_POINT_COUNT, MAX_POINT_COUNT)
  const geometry = createGeometry(reservoir)
  const reference = referenceLayouts[reservoir.id]
  const referencePoints = scopedReferencePoints(reservoir, geometry)
  const useReference = scheme.id === 'sync' && referencePoints.length === count
  const candidates = useReference ? null : scheme.candidateMode === 'shore-access'
    ? buildShoreCandidates(reservoir, geometry, count)
    : buildCandidates(reservoir, geometry, count)
  const sourcePoints = useReference
    ? referencePoints.map(({ name, longitude, latitude }) => {
      const point = geometry.project([longitude, latitude])
      return { ...point, name, shoreDistance: shoreDistanceInGeometry(point, geometry) }
    })
    : selectSpreadPoints(candidates.points, count, scheme.candidateMode !== 'shore-access')
  const points = sourcePoints.map((point, index) => ({
    id: index + 1,
    name: String(index + 1).padStart(2, '0'),
    longitude: Number(point.longitude.toFixed(8)), latitude: Number(point.latitude.toFixed(8)),
    shoreDistanceKm: point.shoreDistance,
  }))
  const metrics = samplingMetrics(points)
  const accessVerificationRequired = scheme.candidateMode === 'shore-access'
  return {
    reservoirId: reservoir.id, reservoirName: reservoir.name_cn, basin: reservoir.basin,
    samplingScope: reservoir.sampling_scope || '河南省境内库区',
    samplingAreaKm2: reservoir.area_km2, fullAreaKm2: reservoir.full_area_km2 || reservoir.area_km2,
    scopeRetainedPct: reservoir.scope_retained_pct || 100,
    count: points.length, prefix: '', points,
    ...metrics,
    shorelineBufferM: Math.round((candidates?.appliedBuffer ?? preferredShoreBuffer(reservoir)) * 1000),
    targetShorelineBufferM: Math.round((candidates?.preferredBuffer ?? preferredShoreBuffer(reservoir)) * 1000),
    bufferException: false,
    source: useReference ? 'reference' : accessVerificationRequired ? 'shore-candidates' : 'generated',
    referenceBasis: useReference ? reference.basis : '', referenceYear: useReference ? reference.year : null,
    schemeId: scheme.id, schemeLabel: scheme.label,
    schemeDescription: useReference ? `${reference.basis} · 仅保留河南库区` : scheme.description,
    candidateMode: scheme.candidateMode || 'water-pattern',
    accessVerificationRequired,
    accessNote: accessVerificationRequired ? (reservoir.shore_candidate_note || '道路、坡岸和管制条件须现场复核') : '',
    fixedCount: false, manualAdjustmentCount: 0,
  }
}

function moveSamplingPoint(reservoir, plan, pointId, longitude, latitude) {
  if (![longitude, latitude].every(Number.isFinite)) throw new Error('目标坐标无效，请重新选择位置')
  const geometry = createGeometry(reservoir)
  const projected = geometry.project([longitude, latitude])
  if (!pointInGeometry(projected, geometry)) throw new Error('点位必须保留在河南库区水面范围内')
  let moved = false
  const points = plan.points.map((point) => {
    if (point.id !== pointId) return point
    moved = true
    return { ...point, longitude: Number(longitude.toFixed(8)), latitude: Number(latitude.toFixed(8)),
      shoreDistanceKm: shoreDistanceInGeometry(projected, geometry), manuallyAdjusted: true }
  })
  if (!moved) throw new Error('没有找到需要调整的点位')
  return updateManuallyEditedPlan(plan, points)
}

function updateManuallyEditedPlan(plan, points) {
  const metrics = samplingMetrics(points)
  return { ...plan, ...metrics, count: points.length, points,
    bufferException: metrics.minimumShoreDistanceM < plan.shorelineBufferM,
    manualAdjustmentCount: points.filter((point) => point.manuallyAdjusted).length }
}

function addSamplingPoint(reservoir, plan, longitude, latitude) {
  if (plan.count >= MAX_POINT_COUNT) throw new Error(`采样点最多为 ${MAX_POINT_COUNT} 个`)
  if (![longitude, latitude].every(Number.isFinite)) throw new Error('目标坐标无效，请重新选择位置')
  const geometry = createGeometry(reservoir)
  const projected = geometry.project([longitude, latitude])
  if (!pointInGeometry(projected, geometry)) throw new Error('新增点位必须位于河南库区水面范围内')
  const id = plan.points.length + 1
  const points = [...plan.points, {
    id, name: String(id).padStart(2, '0'),
    longitude: Number(longitude.toFixed(8)), latitude: Number(latitude.toFixed(8)),
    shoreDistanceKm: shoreDistanceInGeometry(projected, geometry),
    manuallyAdjusted: true, manuallyAdded: true,
  }]
  return updateManuallyEditedPlan(plan, points)
}

function removeLastSamplingPoint(plan) {
  if (plan.count <= MIN_POINT_COUNT) throw new Error(`采样点至少保留 ${MIN_POINT_COUNT} 个`)
  return updateManuallyEditedPlan(plan, plan.points.slice(0, -1))
}

function escapeXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function buildOviKml(reservoir, plan) {
  const documentName = `${reservoir.name_cn}-${plan.schemeLabel}采样点`
  const accessText = plan.accessVerificationRequired ? ' · 岸边可达候选，须现场复核道路、坡岸与管制条件' : ''
  const manualText = plan.manualAdjustmentCount ? ` · ${plan.manualAdjustmentCount}个点位已手动编辑` : ''
  const placemarks = plan.points.map((point) => `      <Placemark>
        <name>${escapeXml(point.name)}</name>
        <description>${escapeXml(`${reservoir.name_cn} · 河南库区 · ${plan.schemeLabel} · ${reservoir.basin || ''} · 采样点 ${point.name}${point.manuallyAdded ? ' · 手动新增' : point.manuallyAdjusted ? ' · 手动调整' : ''}${accessText}`)}</description>
        <styleUrl>#m_ylw-pushpin</styleUrl>
        <OvAttr><OvIcon>4</OvIcon><OvIconNum>0</OvIconNum></OvAttr>
        <OvCoordType>CGCS2000</OvCoordType>
        <Point><coordinates>${point.longitude.toFixed(8)},${point.latitude.toFixed(8)},0</coordinates></Point>
      </Placemark>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
  <Document>
    <name>${escapeXml(documentName)}</name>
    <description>${escapeXml(`${plan.samplingScope} · ${plan.schemeDescription}${manualText}${accessText}`)}</description>
    <Style id="s_ylw-pushpin"><IconStyle><scale>1.1</scale><Icon><href>http://maps.google.com/mapfiles/kml/pushpin/ylw-pushpin.png</href></Icon></IconStyle></Style>
    <StyleMap id="m_ylw-pushpin"><Pair><key>normal</key><styleUrl>#s_ylw-pushpin</styleUrl></Pair><Pair><key>highlight</key><styleUrl>#s_ylw-pushpin</styleUrl></Pair></StyleMap>
    <Folder>
      <name>${escapeXml(documentName)}</name>
${placemarks}
    </Folder>
  </Document>
</kml>
`
}

function buildSamplingMap(plan, coordinateConverter, selectedPointId = 0, measuredPointIds = []) {
  const mapPoints = plan.points.map((point) => coordinateConverter(point.longitude, point.latitude))
  const measuredIds = new Set(measuredPointIds)
  const measuredMapPoints = measuredPointIds
    .map((id) => mapPoints[plan.points.findIndex((point) => point.id === id)])
    .filter(Boolean)
  const center = mapPoints.reduce((result, point) => ({
    longitude: result.longitude + point.longitude / mapPoints.length,
    latitude: result.latitude + point.latitude / mapPoints.length,
  }), { longitude: 0, latitude: 0 })
  return {
    includePoints: mapPoints,
    view: {
      ...center, scale: 11,
      markers: mapPoints.map((point, index) => ({
        id: index + 1, ...point, iconPath: '/assets/marker-selected.png',
        width: selectedPointId === index + 1 ? 40 : measuredIds.has(index + 1) ? 38 : 32,
        height: selectedPointId === index + 1 ? 50 : measuredIds.has(index + 1) ? 48 : 40,
        label: { content: plan.points[index].name,
          padding: 5, fontSize: 11, color: '#06141d',
          bgColor: selectedPointId === index + 1 ? '#ebcb8b' : measuredIds.has(index + 1) ? '#b48ead' : plan.points[index].manuallyAdjusted ? '#d6a84d' : '#88c0d0',
          borderRadius: 9, anchorX: -7,
          anchorY: selectedPointId === index + 1 ? -55 : measuredIds.has(index + 1) ? -52 : -44 },
      })),
      polyline: [
        ...(mapPoints.length > 1 ? [{ points: mapPoints, color: '#BF616ACC', width: 3, dottedLine: true }] : []),
        ...(measuredMapPoints.length === 2
          ? [{ points: measuredMapPoints, color: '#B48EADFF', width: 4, dottedLine: false }]
          : []),
      ],
    },
  }
}

module.exports = {
  REFERENCE_COUNTS, MAX_POINT_COUNT, MIN_POINT_COUNT, defaultPointCount, standardPointCount, shorePointCount,
  schemePointCount, getSamplingSchemes, buildSamplingPlan, moveSamplingPoint, addSamplingPoint,
  removeLastSamplingPoint, samplingPointDistanceM, buildSamplingMap, buildOviKml,
  largestRing, createGeometry, pointInGeometry,
}
