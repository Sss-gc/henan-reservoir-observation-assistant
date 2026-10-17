// Generated from src/services/recommendation.ts.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildExperimentRecommendation = buildExperimentRecommendation;
const GLINT_LABEL = { high: '高', medium: '中', low: '低', minimal: '极低' };
const GLINT_PENALTY = { high: 20, medium: 10, low: 5, minimal: 0 };
function weatherBaseScore(condition) {
    if (/雷|雨|雪|冰雹|雾|霾|沙尘|台风/.test(condition))
        return 20;
    if (condition.includes('阴'))
        return 45;
    if (condition.includes('多云'))
        return 70;
    if (condition.includes('晴'))
        return 90;
    return 40;
}
function buildExperimentRecommendation(pass, weather) {
    var _a;
    const day = (_a = weather === null || weather === void 0 ? void 0 : weather.days.find((item) => item.date === pass.date)) !== null && _a !== void 0 ? _a : null;
    const glintReason = `耀光${GLINT_LABEL[pass.glint_risk]}风险 ${pass.glint_angle_deg.toFixed(1)}°`;
    if (!day) {
        return {
            satellitePass: pass,
            weatherDay: null,
            score: null,
            level: '待预报',
            reasons: ['超出中央气象台未来7天天气预报范围', glintReason],
        };
    }
    const sunny = day.dayCondition.trim() === '晴';
    const score = sunny ? 100 - GLINT_PENALTY[pass.glint_risk] : weatherBaseScore(day.dayCondition);
    const level = sunny ? '推荐' : '不推荐';
    return {
        satellitePass: pass,
        weatherDay: day,
        score,
        level,
        reasons: [sunny ? '白天天气为晴，符合出差实验条件' : `白天${day.dayCondition}，不符合晴天出差条件`, glintReason],
    };
}
