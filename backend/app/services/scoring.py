from __future__ import annotations

from typing import Any


def clamp(value: float) -> float:
    return max(0.0, min(100.0, value))


def score_weather(day: dict[str, Any]) -> tuple[int, str, str, dict[str, float]]:
    cloud = clamp(100 - day["cloudCover"] * 1.18)
    rain = clamp(100 - day["precipitationProbability"] * 0.9 - day["precipitation"] * 8)
    wind = clamp(100 if day["windSpeed"] <= 2 else 100 - (day["windSpeed"] - 2) * 18)
    visibility = clamp(100 - day["cloudCover"] * 0.35 - day["precipitationProbability"] * 0.25)
    solar = clamp((day["radiation"] / 24) * 100)
    score = round(cloud * 0.4 + rain * 0.2 + wind * 0.2 + visibility * 0.1 + solar * 0.1)
    level = "推荐" if score >= 78 else "可选" if score >= 58 else "不推荐"
    reasons = [
        "云量较低" if day["cloudCover"] <= 30 else f"云量{day['cloudCover']}%",
        "降水风险低" if day["precipitationProbability"] <= 25 else f"降水概率{day['precipitationProbability']}%",
        "风速平稳" if day["windSpeed"] <= 3 else f"风速{day['windSpeed']}m/s",
    ]
    return score, level, " · ".join(reasons), {
        "cloud": round(cloud, 2),
        "rain": round(rain, 2),
        "wind": round(wind, 2),
        "visibility_proxy": round(visibility, 2),
        "solar": round(solar, 2),
    }


def build_recommendations(passes: list[dict], weather_days: list[dict]) -> list[dict]:
    weather_by_date = {item["date"]: item for item in weather_days}
    results = []
    for satellite_pass in passes:
        item = dict(satellite_pass)
        day = weather_by_date.get(item["date"])
        if day is None:
            item.update(
                {
                    "score": None,
                    "level": "待预报",
                    "reason": "超出16天天气预报范围",
                    "weather_available": False,
                    "score_components": None,
                }
            )
        else:
            score, level, reason, components = score_weather(day)
            item.update(
                {
                    "score": score,
                    "level": level,
                    "reason": reason,
                    "weather_available": True,
                    "weather": day,
                    "score_components": components,
                    "scoring_version": "transparent-rule-v0.1",
                }
            )
        results.append(item)
    return results
