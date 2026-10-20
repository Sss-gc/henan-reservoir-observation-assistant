import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson'

export interface ReservoirProperties {
  id: string
  code: string
  name_cn: string
  basin?: string
  city: string
  lon: number
  lat: number
  area_km2: number
  osm_id: string
  feature_class: string
  data_source: string
  geometry_status: string
}

export type ReservoirFeature = Feature<Polygon | MultiPolygon, ReservoirProperties>
export type ReservoirCollection = FeatureCollection<Polygon | MultiPolygon, ReservoirProperties>

export interface WeatherDay {
  date: string
  dayCondition: string
  nightCondition: string
}

export interface WeatherResult {
  days: WeatherDay[]
  source: string
  sourceUrl: string
  stationName: string
  publishedAt: string | null
  fetchedAt: string
  cacheStatus: string
}

export interface SatellitePass {
  id: string
  reservoir_id: string
  date: string
  time: string
  timezone: string
  time_utc: string
  satellite: string
  sensor: string
  resolution_m: number
  swath_km: number
  confidence: 'B'
  coverage: number
  min_distance_km: number
  coverage_method: string
  element_epoch: string
  solar_elevation_deg: number
  solar_azimuth_deg: number
  satellite_elevation_deg: number
  satellite_azimuth_deg: number
  glint_angle_deg: number
  glint_risk: 'high' | 'medium' | 'low' | 'minimal'
  is_imaging_confirmed: false
}

export interface OrbitPassPayload {
  schema_version: string
  generated_at: string
  timezone: string
  forecast_days: number
  source: string
  element_epoch_latest: string | null
  coverage_rule: string
  coverage_method: string
  glint_method: string
  glint_thresholds_deg: { high: number; medium: number; low: number }
  is_imaging_confirmed: false
  warning: string
  reservoir_count: number
  reservoirs_with_passes: number
  item_count: number
  items: SatellitePass[]
}

export interface ExperimentRecommendation {
  satellitePass: SatellitePass
  weatherDay: WeatherDay | null
  score: number | null
  level: '推荐' | '备选' | '不推荐' | '待预报'
  reasons: string[]
}

export type SamplingCoordinate = [number, number]

export interface SamplingScopeProperties {
  id: string
  scope: string
  sampling_area_km2: number
  full_area_km2: number
  retained_pct: number
  lon: number
  lat: number
  shore_candidates: SamplingCoordinate[]
  shore_candidate_note: string
}

export type SamplingScopeFeature = Feature<Polygon | MultiPolygon, SamplingScopeProperties>
export type SamplingScopeCollection = FeatureCollection<Polygon | MultiPolygon, SamplingScopeProperties>

export interface SamplingReservoir {
  id: string
  code: string
  name_cn: string
  city: string
  basin: string
  lon: number
  lat: number
  area_km2: number
  full_area_km2: number
  scope_retained_pct: number
  sampling_scope: string
  shore_candidate_note: string
  shore_candidates: SamplingCoordinate[]
  polygons: SamplingCoordinate[][][]
  rings: SamplingCoordinate[][]
}

export interface SamplingReferencePoint {
  name: string
  longitude: number
  latitude: number
}

export interface SamplingReferenceLayout {
  basis: string
  year: number | null
  points: SamplingReferencePoint[]
}

export type SamplingReferenceLayouts = Record<string, SamplingReferenceLayout>
