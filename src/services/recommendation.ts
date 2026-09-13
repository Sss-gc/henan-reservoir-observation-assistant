import type { ExperimentRecommendation, SatellitePass, WeatherResult } from '../types'

const GLINT_LABEL = { high: '高', medium: '中', low: '低', minimal: '极低' }
const GLINT_PENALTY = { high: 35, medium: 20, low: 5, minimal: 0 }

function weatherBaseScore(condition: string) {
  if (/雷|雨|雪|冰雹|雾|霾|沙尘|台风/.test(condition)) return 20
  if (condition.includes('阴')) return 45
  if (condition.includes('多云')) return 70
  if (condition.includes('晴')) return 90
  return 40
}

export function buildExperimentRecommendation(
  pass: SatellitePass,
  weather: WeatherResult | null,
): ExperimentRecommendation {
  const day = weather?.days.find((item) => item.date === pass.date) ?? null
  const glintReason = `耀光${GLINT_LABEL[pass.glint_risk]}风险 ${pass.glint_angle_deg.toFixed(1)}°`
  if (!day) {
    return {
      satellitePass: pass,
      weatherDay: null,
      score: null,
      level: '待预报',
      reasons: ['超出中央气象台未来7天天气预报范围', glintReason],
    }
  }

  const score = Math.max(0, weatherBaseScore(day.dayCondition) - GLINT_PENALTY[pass.glint_risk])
  const hazardous = /雷|雨|雪|冰雹|雾|霾|沙尘|台风/.test(day.dayCondition)
  const level = !hazardous && day.dayCondition.includes('晴') && ['low', 'minimal'].includes(pass.glint_risk) && score >= 75
    ? '推荐'
    : score >= 55 && pass.glint_risk !== 'high' ? '备选' : '不推荐'
  return {
    satellitePass: pass,
    weatherDay: day,
    score,
    level,
    reasons: [`白天${day.dayCondition}（夜间${day.nightCondition}）`, glintReason],
  }
}
