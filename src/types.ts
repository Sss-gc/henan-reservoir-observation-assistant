import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson'

export interface ReservoirProperties {
  id: string
  code: string
  name_cn: string
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
  weatherCode: number
  temperatureMax: number
  temperatureMin: number
  cloudCover: number
  precipitationProbability: number
  precipitation: number
  windSpeed: number
  radiation: number
}

export interface WeatherHour {
  time: string
  temperature: number
  cloudCover: number
  precipitationProbability: number
  precipitation: number
  windSpeed: number
}

export interface WeatherResult {
  days: WeatherDay[]
  hours: WeatherHour[]
  source: string
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
  weatherHour: WeatherHour | null
  score: number | null
  level: '推荐' | '备选' | '不推荐' | '待预报'
  reasons: string[]
}
