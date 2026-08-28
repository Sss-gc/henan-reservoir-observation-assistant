import type { ExperimentRecommendation, SatellitePass, WeatherResult } from '../types'

export interface ExperimentThresholds {
  maxCloud: number
  maxRainProbability: number
  maxWind: number
}

export function nearestWeatherHour(pass: SatellitePass, weather: WeatherResult) {
  const target = new Date(`${pass.date}T${pass.time}:00+08:00`).getTime()
  return weather.hours
    .filter((hour) => hour.time.startsWith(pass.date))
    .map((hour) => ({ hour, distance: Math.abs(new Date(`${hour.time}:00+08:00`).getTime() - target) }))
    .sort((a, b) => a.distance - b.distance)[0]?.hour ?? null
}

export function buildExperimentRecommendation(
  pass: SatellitePass,
  weather: WeatherResult | null,
  thresholds: ExperimentThresholds,
): ExperimentRecommendation {
  const day = weather?.days.find((item) => item.date === pass.date) ?? null
  const hour = weather ? nearestWeatherHour(pass, weather) : null
  if (!day || !hour) {
    return {
      satellitePass: pass,
      weatherDay: day,
      weatherHour: hour,
      score: null,
      level: '待预报',
      reasons: [
        '超出未来16天天气预报范围',
        `耀光${{ high: '高', medium: '中', low: '低', minimal: '极低' }[pass.glint_risk]}风险 ${pass.glint_angle_deg.toFixed(1)}°`,
      ],
    }
  }
  const glintPenalty = { high: 35, medium: 20, low: 6, minimal: 0 }[pass.glint_risk]
  const score = Math.max(0, Math.round(
    100 - hour.cloudCover * 0.5 - hour.precipitationProbability * 0.25
    - hour.precipitation * 10 - Math.max(0, hour.windSpeed - 2) * 8 - glintPenalty,
  ))
  const strict = hour.cloudCover <= thresholds.maxCloud
    && hour.precipitationProbability <= thresholds.maxRainProbability
    && hour.precipitation <= 0.2
    && hour.windSpeed <= thresholds.maxWind
    && pass.glint_risk !== 'high'
    && pass.glint_risk !== 'medium'
  const level = strict && score >= 75 ? '推荐' : score >= 55 ? '备选' : '不推荐'
  return {
    satellitePass: pass,
    weatherDay: day,
    weatherHour: hour,
    score,
    level,
    reasons: [
      `过境云量${Math.round(hour.cloudCover)}%`,
      `降水概率${Math.round(hour.precipitationProbability)}%`,
      `风速${hour.windSpeed.toFixed(1)}m/s`,
      `耀光${{ high: '高', medium: '中', low: '低', minimal: '极低' }[pass.glint_risk]}风险 ${pass.glint_angle_deg.toFixed(1)}°`,
    ],
  }
}
