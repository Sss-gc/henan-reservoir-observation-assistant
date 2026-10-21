import type {
  MultiPolygon, Polygon,
} from 'geojson'
import type {
  ReservoirFeature, SamplingCoordinate, SamplingReferenceLayouts, SamplingReservoir,
  SamplingScopeFeature,
} from '../types'

export const MAX_POINT_COUNT = 50
export const MIN_POINT_COUNT = 6

const BASIN_BY_RESERVOIR_ID = new Map<string, string>([
  ...['HN_RSV_002', 'HN_RSV_010', 'HN_RSV_011', 'HN_RSV_016', 'HN_RSV_017'].map((id) => [id, '黄河流域'] as const),
  ...['HN_RSV_003', 'HN_RSV_004', 'HN_RSV_005', 'HN_RSV_008', 'HN_RSV_009', 'HN_RSV_013', 'HN_RSV_014', 'HN_RSV_015', 'HN_RSV_018', 'HN_RSV_019', 'HN_RSV_020', 'HN_RSV_021', 'HN_RSV_022', 'HN_RSV_023', 'HN_RSV_025'].map((id) => [id, '淮河流域'] as const),
  ...['HN_RSV_006', 'HN_RSV_012', 'HN_RSV_024'].map((id) => [id, '长江流域'] as const),
  ...['HN_RSV_001', 'HN_RSV_007', 'HN_RSV_026'].map((id) => [id, '海河流域'] as const),
])

export interface SamplingScheme {
  id: 'sync' | 'shore'
  label: string
  badge: string
  description: string
  candidateMode?: 'shore-access'
  count?: number
  fixed?: boolean
}

export interface SamplingPoint {
  id: number
  name: string
  longitude: number
  latitude: number
  shoreDistanceKm: number
  manuallyAdjusted?: boolean
}

export interface SamplingPlan {
  reservoirId: string
  reservoirName: string
  basin: string
  samplingScope: string
  samplingAreaKm2: number
  fullAreaKm2: number
  scopeRetainedPct: number
  count: number
  prefix: string
  points: SamplingPoint[]
  routeDistanceKm: number
  meanSpacingKm: number
  minimumSpacingKm: number
  shorelineBufferM: number
  targetShorelineBufferM: number
  minimumShoreDistanceM: number
  bufferException: boolean
  source: 'reference' | 'shore-candidates' | 'generated'
  referenceBasis: string
  referenceYear: number | null
  schemeId: 'sync' | 'shore'
  schemeLabel: string
  schemeDescription: string
  candidateMode: 'shore-access' | 'water-pattern'
  accessVerificationRequired: boolean
  accessNote: string
  fixedCount: boolean
  manualAdjustmentCount: number
}

interface ProjectedPoint {
  x: number
  y: number
  longitude: number
  latitude: number
  shoreDistance: number
  name?: string
}

interface ProjectedRingPoint {
  x: number
  y: number
  longitude: number
  latitude: number
}

interface SamplingGeometry {
  polygons: Array<{ outer: ProjectedRingPoint[]; holes: ProjectedRingPoint[][] }>
  project: (coordinate: SamplingCoordinate) => ProjectedRingPoint
  unproject: (point: Pick<ProjectedRingPoint, 'x' | 'y'>) => Pick<ProjectedRingPoint, 'longitude' | 'latitude'>
}

const SAMPLING_SCHEMES: SamplingScheme[] = [
  { id: 'sync', label: '星地同步', badge: '推荐', description: '参照既有点位的布局与分布规律' },
  { id: 'shore', label: '岸边加密', badge: '候选', description: '河南库区岸边可达候选 · 需现场复核', candidateMode: 'shore-access' },
]

const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value))

export function reservoirBasin(id: string) {
  return BASIN_BY_RESERVOIR_ID.get(id) ?? '流域待核验'
}

function geometryPolygons(geometry: Polygon | MultiPolygon): SamplingCoordinate[][][] {
  return geometry.type === 'MultiPolygon'
    ? geometry.coordinates as SamplingCoordinate[][][]
    : [geometry.coordinates as SamplingCoordinate[][]]
}

export function createSamplingReservoir(feature: ReservoirFeature, scope: SamplingScopeFeature): SamplingReservoir {
  // Match the mini program's prepared boundaries so both clients select the same points.
  const polygons = geometryPolygons(scope.geometry).map((polygon) => polygon.map((ring) =>
    ring.map(([longitude, latitude]): SamplingCoordinate => [
      Number(longitude.toFixed(6)), Number(latitude.toFixed(6)),
    ])))
  return {
    id: feature.properties.id,
    code: feature.properties.code,
    name_cn: feature.properties.name_cn,
    city: feature.properties.city.replace(/（跨湖北省十堰市）/g, ''),
    basin: feature.properties.basin?.trim() || reservoirBasin(feature.properties.id),
    lon: scope.properties.lon,
    lat: scope.properties.lat,
    area_km2: scope.properties.sampling_area_km2,
    full_area_km2: scope.properties.full_area_km2,
    scope_retained_pct: scope.properties.retained_pct,
    sampling_scope: scope.properties.scope,
    shore_candidate_note: scope.properties.shore_candidate_note,
    shore_candidates: scope.properties.shore_candidates,
    polygons,
    rings: polygons.flat(),
  }
}

function normalizeRing(ring: SamplingCoordinate[]) {
  const points = (ring || []).filter((point) => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]))
  if (points.length > 3) {
    const first = points[0]
    const last = points[points.length - 1]
    if (first[0] === last[0] && first[1] === last[1]) return points.slice(0, -1)
  }
  return points
}

function simplifyRing(ring: SamplingCoordinate[], maximumVertices = 900) {
  if (ring.length <= maximumVertices) return ring
  const step = Math.ceil(ring.length / maximumVertices)
  const result: SamplingCoordinate[] = []
  for (let index = 0; index < ring.length; index += step) result.push(ring[index])
  return result
}

function pointInRing(point: Pick<ProjectedRingPoint, 'x' | 'y'>, ring: ProjectedRingPoint[]) {
  let inside = false
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const { x: xi, y: yi } = ring[index]
    const { x: xj, y: yj } = ring[previous]
    const crosses = (yi > point.y) !== (yj > point.y)
      && point.x < (xj - xi) * (point.y - yi) / ((yj - yi) || Number.EPSILON) + xi
    if (crosses) inside = !inside
  }
  return inside
}

function distanceToSegment(point: Pick<ProjectedRingPoint, 'x' | 'y'>, start: ProjectedRingPoint, end: ProjectedRingPoint) {
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (!dx && !dy) return Math.hypot(point.x - start.x, point.y - start.y)
  const ratio = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy), 0, 1)
  return Math.hypot(point.x - start.x - ratio * dx, point.y - start.y - ratio * dy)
}

function distanceToRing(point: Pick<ProjectedRingPoint, 'x' | 'y'>, ring: ProjectedRingPoint[]) {
  let result = Infinity
  for (let index = 0; index < ring.length; index++) {
    result = Math.min(result, distanceToSegment(point, ring[index], ring[(index + 1) % ring.length]))
  }
  return result
}

export function createGeometry(reservoir: SamplingReservoir): SamplingGeometry {
  const sourcePolygons = reservoir.polygons
  const allCoordinates = sourcePolygons.flat(2)
  if (allCoordinates.length < 3) throw new Error('该水库缺少可用的水面边界')
  const centerLatitude = allCoordinates.reduce((sum, point) => sum + point[1], 0) / allCoordinates.length
  const lonScale = 111.32 * Math.cos(centerLatitude * Math.PI / 180)
  const latScale = 110.574
  const originLongitude = Math.min(...allCoordinates.map((point) => point[0]))
  const originLatitude = Math.min(...allCoordinates.map((point) => point[1]))
  const project = ([longitude, latitude]: SamplingCoordinate): ProjectedRingPoint => ({
    x: (longitude - originLongitude) * lonScale,
    y: (latitude - originLatitude) * latScale,
    longitude,
    latitude,
  })
  const unproject = ({ x, y }: Pick<ProjectedRingPoint, 'x' | 'y'>) => ({
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

function polygonForPoint(point: Pick<ProjectedRingPoint, 'x' | 'y'>, geometry: SamplingGeometry) {
  return geometry.polygons.find((polygon) => pointInRing(point, polygon.outer)
    && !polygon.holes.some((hole) => pointInRing(point, hole))) || null
}

export function pointInGeometry(point: Pick<ProjectedRingPoint, 'x' | 'y'>, geometry: SamplingGeometry) {
  return Boolean(polygonForPoint(point, geometry))
}

function shoreDistanceInGeometry(point: Pick<ProjectedRingPoint, 'x' | 'y'>, geometry: SamplingGeometry) {
  const polygon = polygonForPoint(point, geometry)
  if (!polygon) return 0
  return Math.min(distanceToRing(point, polygon.outer), ...polygon.holes.map((hole) => distanceToRing(point, hole)))
}

function preferredShoreBuffer(reservoir: SamplingReservoir) {
  return clamp(Math.sqrt(Math.max(1, reservoir.area_km2 || 1)) / 35, 0.15, 0.55)
}

function buildCandidates(reservoir: SamplingReservoir, geometry: SamplingGeometry, count: number) {
  const outerPoints = geometry.polygons.flatMap((polygon) => polygon.outer)
  const xs = outerPoints.map((point) => point.x)
  const ys = outerPoints.map((point) => point.y)
  const west = Math.min(...xs)
  const east = Math.max(...xs)
  const south = Math.min(...ys)
  const north = Math.max(...ys)
  const width = east - west
  const height = north - south
  const maximum = Math.max(width, height)
  const columns = clamp(Math.round(68 * width / maximum), 24, 68)
  const rows = clamp(Math.round(68 * height / maximum), 24, 68)
  const inside: ProjectedPoint[] = []
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const base = {
        x: west + (column + 0.5 + (row % 2 ? 0.18 : -0.18)) * width / columns,
        y: south + (row + 0.5) * height / rows,
      }
      if (!pointInGeometry(base, geometry)) continue
      const coordinate = geometry.unproject(base)
      inside.push({ ...base, ...coordinate, shoreDistance: shoreDistanceInGeometry(base, geometry) })
    }
  }
  if (inside.length < count) throw new Error('水面边界过窄，无法生成足够的候选点')
  const preferredBuffer = preferredShoreBuffer(reservoir)
  const distances = inside.map((point) => point.shoreDistance).sort((left, right) => right - left)
  const achievableBuffer = distances[Math.min(count - 1, distances.length - 1)] || 0
  const appliedBuffer = Math.min(preferredBuffer, achievableBuffer)
  return { points: inside.filter((point) => point.shoreDistance + 1e-9 >= appliedBuffer), preferredBuffer, appliedBuffer }
}

function buildShoreCandidates(reservoir: SamplingReservoir, geometry: SamplingGeometry, count: number) {
  const points = (reservoir.shore_candidates || []).map(([longitude, latitude]) => {
    const base = geometry.project([longitude, latitude])
    return { ...base, shoreDistance: shoreDistanceInGeometry(base, geometry) }
  }).filter((point) => pointInGeometry(point, geometry) && point.shoreDistance >= 0.01 && point.shoreDistance <= 0.2)
  if (points.length < count) throw new Error('河南库区岸边候选点不足，请重新生成空间数据')
  return { points, preferredBuffer: 0.075, appliedBuffer: 0.075 }
}

function principalAxis(points: ProjectedPoint[]) {
  const centerX = points.reduce((sum, point) => sum + point.x, 0) / points.length
  const centerY = points.reduce((sum, point) => sum + point.y, 0) / points.length
  let xx = 0
  let yy = 0
  let xy = 0
  for (const point of points) {
    const x = point.x - centerX
    const y = point.y - centerY
    xx += x * x
    yy += y * y
    xy += x * y
  }
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy)
  return { x: Math.cos(angle), y: Math.sin(angle), centerX, centerY }
}

function selectSpreadPoints(candidates: ProjectedPoint[], count: number, favorInterior = true) {
  const axis = principalAxis(candidates)
  const projection = (point: ProjectedPoint) => (point.x - axis.centerX) * axis.x + (point.y - axis.centerY) * axis.y
  const maximumShoreDistance = Math.max(...candidates.map((point) => point.shoreDistance), 0.001)
  const selected: ProjectedPoint[] = []
  const first = candidates.reduce((best, point) => projection(point) < projection(best) ? point : best, candidates[0])
  selected.push(first)
  const used = new Set<ProjectedPoint>([first])
  while (selected.length < count) {
    let best: ProjectedPoint | null = null
    let bestScore = -1
    for (const candidate of candidates) {
      if (used.has(candidate)) continue
      const nearest = Math.min(...selected.map((point) => Math.hypot(candidate.x - point.x, candidate.y - point.y)))
      const weight = favorInterior ? 0.88 + 0.12 * candidate.shoreDistance / maximumShoreDistance : 1
      const score = nearest * weight
      if (score > bestScore) {
        best = candidate
        bestScore = score
      }
    }
    if (!best) break
    used.add(best)
    selected.push(best)
  }
  const remaining = new Set(selected)
  const firstRoutePoint = selected.reduce((best, point) => projection(point) < projection(best) ? point : best, selected[0])
  const route = [firstRoutePoint]
  remaining.delete(firstRoutePoint)
  while (remaining.size) {
    const current = route[route.length - 1]
    let nearest: ProjectedPoint | null = null
    let nearestDistance = Infinity
    for (const candidate of remaining) {
      const distance = Math.hypot(candidate.x - current.x, candidate.y - current.y)
      if (distance < nearestDistance) {
        nearest = candidate
        nearestDistance = distance
      }
    }
    if (!nearest) break
    route.push(nearest)
    remaining.delete(nearest)
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

function distanceKm(start: Pick<SamplingPoint, 'longitude' | 'latitude'>, end: Pick<SamplingPoint, 'longitude' | 'latitude'>) {
  const radius = 6371
  const lat1 = start.latitude * Math.PI / 180
  const lat2 = end.latitude * Math.PI / 180
  const dLat = lat2 - lat1
  const dLon = (end.longitude - start.longitude) * Math.PI / 180
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * radius * Math.asin(Math.sqrt(value))
}

function samplingMetrics(points: SamplingPoint[]) {
  const distances = points.slice(1).map((point, index) => distanceKm(points[index], point))
  const routeDistanceKm = distances.reduce((sum, distance) => sum + distance, 0)
  return {
    routeDistanceKm: Number(routeDistanceKm.toFixed(1)),
    meanSpacingKm: Number((routeDistanceKm / Math.max(1, distances.length)).toFixed(1)),
    minimumSpacingKm: Number((distances.length ? Math.min(...distances) : 0).toFixed(1)),
    minimumShoreDistanceM: Math.round(Math.min(...points.map((point) => point.shoreDistanceKm)) * 1000),
  }
}

function scopedReferencePoints(reservoir: SamplingReservoir, references: SamplingReferenceLayouts, geometry = createGeometry(reservoir)) {
  const reference = references[reservoir.id]
  if (!reference) return []
  if ((reservoir.scope_retained_pct || 100) >= 99.95) return reference.points
  return reference.points.filter(({ longitude, latitude }) => pointInGeometry(geometry.project([longitude, latitude]), geometry))
}

function generatedSyncPointCount(reservoir: SamplingReservoir) {
  return clamp(Math.round(7 + 2.25 * Math.log(Math.max(1, reservoir.area_km2 || 1) + 1)), 8, 25)
}

export function defaultPointCount(reservoir: SamplingReservoir, references: SamplingReferenceLayouts) {
  const referenceCount = scopedReferencePoints(reservoir, references).length
  return referenceCount || generatedSyncPointCount(reservoir)
}

export function shorePointCount(reservoir: SamplingReservoir) {
  const area = Math.max(0, Number(reservoir.area_km2) || 0)
  if (area < 50) return 10
  if (area < 500) return 14
  if (area < 1000) return 19
  if (area < 2000) return 29
  return 49
}

function schemePointCount(reservoir: SamplingReservoir, references: SamplingReferenceLayouts, schemeId: SamplingScheme['id']) {
  return schemeId === 'shore' ? shorePointCount(reservoir) : defaultPointCount(reservoir, references)
}

export function getSamplingSchemes(reservoir: SamplingReservoir, references: SamplingReferenceLayouts) {
  return SAMPLING_SCHEMES.map((scheme) => ({
    ...scheme,
    count: schemePointCount(reservoir, references, scheme.id),
    fixed: false,
  }))
}

export function buildSamplingPlan(
  reservoir: SamplingReservoir,
  references: SamplingReferenceLayouts,
  request: number | { schemeId?: SamplingScheme['id']; count?: number } = { schemeId: 'sync' },
): SamplingPlan {
  const structuredRequest = typeof request === 'object'
  const schemeId = structuredRequest ? (request.schemeId || 'sync') : 'sync'
  const scheme = SAMPLING_SCHEMES.find((item) => item.id === schemeId) || SAMPLING_SCHEMES[0]
  const fallbackCount = schemePointCount(reservoir, references, scheme.id)
  const requestedCount = structuredRequest ? request.count : request
  const count = clamp(Math.round(Number(requestedCount) || fallbackCount), MIN_POINT_COUNT, MAX_POINT_COUNT)
  const geometry = createGeometry(reservoir)
  const reference = references[reservoir.id]
  const referencePoints = scopedReferencePoints(reservoir, references, geometry)
  const useReference = scheme.id === 'sync' && referencePoints.length === count
  const candidates = useReference ? null : scheme.candidateMode === 'shore-access'
    ? buildShoreCandidates(reservoir, geometry, count)
    : buildCandidates(reservoir, geometry, count)
  const sourcePoints: ProjectedPoint[] = useReference
    ? referencePoints.map(({ name, longitude, latitude }) => {
      const point = geometry.project([longitude, latitude])
      return { ...point, name, shoreDistance: shoreDistanceInGeometry(point, geometry) }
    })
    : selectSpreadPoints(candidates!.points, count, scheme.candidateMode !== 'shore-access')
  const points = sourcePoints.map((point, index): SamplingPoint => ({
    id: index + 1,
    name: String(index + 1).padStart(2, '0'),
    longitude: Number(point.longitude.toFixed(8)),
    latitude: Number(point.latitude.toFixed(8)),
    shoreDistanceKm: point.shoreDistance,
  }))
  const metrics = samplingMetrics(points)
  const accessVerificationRequired = scheme.candidateMode === 'shore-access'
  return {
    reservoirId: reservoir.id,
    reservoirName: reservoir.name_cn,
    basin: reservoir.basin,
    samplingScope: reservoir.sampling_scope || '河南省境内库区',
    samplingAreaKm2: reservoir.area_km2,
    fullAreaKm2: reservoir.full_area_km2 || reservoir.area_km2,
    scopeRetainedPct: reservoir.scope_retained_pct || 100,
    count: points.length,
    prefix: '',
    points,
    ...metrics,
    shorelineBufferM: Math.round((candidates?.appliedBuffer ?? preferredShoreBuffer(reservoir)) * 1000),
    targetShorelineBufferM: Math.round((candidates?.preferredBuffer ?? preferredShoreBuffer(reservoir)) * 1000),
    bufferException: false,
    source: useReference ? 'reference' : accessVerificationRequired ? 'shore-candidates' : 'generated',
    referenceBasis: useReference ? reference.basis : '',
    referenceYear: useReference ? reference.year : null,
    schemeId: scheme.id,
    schemeLabel: scheme.label,
    schemeDescription: useReference ? `${reference.basis} · 仅保留河南库区` : scheme.description,
    candidateMode: scheme.candidateMode || 'water-pattern',
    accessVerificationRequired,
    accessNote: accessVerificationRequired
      ? (reservoir.shore_candidate_note || '道路、坡岸和管制条件须现场复核')
      : '',
    fixedCount: false,
    manualAdjustmentCount: 0,
  }
}

export function moveSamplingPoint(
  reservoir: SamplingReservoir,
  plan: SamplingPlan,
  pointId: number,
  longitude: number,
  latitude: number,
): SamplingPlan {
  if (![longitude, latitude].every(Number.isFinite)) throw new Error('目标坐标无效，请重新选择位置')
  const geometry = createGeometry(reservoir)
  const projected = geometry.project([longitude, latitude])
  if (!pointInGeometry(projected, geometry)) throw new Error('点位必须保留在河南库区水面范围内')
  let moved = false
  const points = plan.points.map((point) => {
    if (point.id !== pointId) return point
    moved = true
    return {
      ...point,
      longitude: Number(longitude.toFixed(8)),
      latitude: Number(latitude.toFixed(8)),
      shoreDistanceKm: shoreDistanceInGeometry(projected, geometry),
      manuallyAdjusted: true,
    }
  })
  if (!moved) throw new Error('没有找到需要调整的点位')
  const metrics = samplingMetrics(points)
  return {
    ...plan,
    ...metrics,
    points,
    bufferException: metrics.minimumShoreDistanceM < plan.shorelineBufferM,
    manualAdjustmentCount: points.filter((point) => point.manuallyAdjusted).length,
  }
}

function escapeXml(value: unknown) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

export function buildOviKml(reservoir: SamplingReservoir, plan: SamplingPlan) {
  const documentName = `${reservoir.name_cn}-${plan.schemeLabel}采样点`
  const accessText = plan.accessVerificationRequired ? ' · 岸边可达候选，须现场复核道路、坡岸与管制条件' : ''
  const manualText = plan.manualAdjustmentCount ? ` · ${plan.manualAdjustmentCount}个点位已手动调整` : ''
  const placemarks = plan.points.map((point) => `      <Placemark>
        <name>${escapeXml(point.name)}</name>
        <description>${escapeXml(`${reservoir.name_cn} · 河南库区 · ${plan.schemeLabel} · ${reservoir.basin} · 采样点 ${point.name}${point.manuallyAdjusted ? ' · 手动调整' : ''}${accessText}`)}</description>
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
