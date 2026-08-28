from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any

import httpx
from sqlalchemy.orm import Session

from ..config import OPEN_METEO_URL, WEATHER_CACHE_TTL_SECONDS
from ..models import WeatherCache


DAILY_FIELDS = [
    "weather_code",
    "temperature_2m_max",
    "temperature_2m_min",
    "precipitation_probability_max",
    "precipitation_sum",
    "wind_speed_10m_max",
    "shortwave_radiation_sum",
]


def _cloud_average(times: list[str], values: list[float | None]) -> dict[str, int]:
    groups: dict[str, list[float]] = defaultdict(list)
    for timestamp, value in zip(times, values):
        if value is not None:
            groups[timestamp[:10]].append(float(value))
    return {
        date: round(sum(day_values) / len(day_values))
        for date, day_values in groups.items()
        if day_values
    }


def _normalize(payload: dict[str, Any], days: int) -> list[dict[str, Any]]:
    daily = payload["daily"]
    clouds = _cloud_average(payload["hourly"]["time"], payload["hourly"]["cloud_cover"])
    results = []
    for index, date in enumerate(daily["time"][:days]):
        results.append(
            {
                "date": date,
                "weatherCode": daily["weather_code"][index],
                "temperatureMax": daily["temperature_2m_max"][index],
                "temperatureMin": daily["temperature_2m_min"][index],
                "cloudCover": clouds.get(date, 0),
                "precipitationProbability": daily["precipitation_probability_max"][index] or 0,
                "precipitation": daily["precipitation_sum"][index] or 0,
                "windSpeed": daily["wind_speed_10m_max"][index] or 0,
                "radiation": daily["shortwave_radiation_sum"][index] or 0,
                "fallback": False,
            }
        )
    return results


async def _download(latitude: float, longitude: float, days: int) -> list[dict[str, Any]]:
    params = {
        "latitude": latitude,
        "longitude": longitude,
        "timezone": "Asia/Shanghai",
        "forecast_days": min(days, 16),
        "wind_speed_unit": "ms",
        "daily": ",".join(DAILY_FIELDS),
        "hourly": "cloud_cover",
    }
    timeout = httpx.Timeout(15.0, connect=8.0)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        response = await client.get(OPEN_METEO_URL, params=params)
        response.raise_for_status()
        return _normalize(response.json(), days)


def _cache_payload(cache: WeatherCache, status: str, days: int) -> dict[str, Any]:
    return {
        "source": "open-meteo",
        "cache_status": status,
        "fetched_at": cache.fetched_at.isoformat() + "Z",
        "timezone": "Asia/Shanghai",
        "days": json.loads(cache.payload)[:days],
    }


async def get_weather(
    db: Session,
    reservoir: dict[str, Any],
    days: int,
    force_refresh: bool = False,
) -> dict[str, Any]:
    reservoir_id = reservoir["properties"]["id"]
    now = datetime.utcnow()
    cache = db.get(WeatherCache, reservoir_id)
    fresh_after = now - timedelta(seconds=WEATHER_CACHE_TTL_SECONDS)

    if cache and cache.fetched_at >= fresh_after and not force_refresh:
        return _cache_payload(cache, "fresh", days)

    props = reservoir["properties"]
    try:
        weather_days = await _download(props["lat"], props["lon"], days)
        if cache is None:
            cache = WeatherCache(
                reservoir_id=reservoir_id,
                fetched_at=now,
                payload=json.dumps(weather_days, ensure_ascii=False),
            )
            db.add(cache)
        else:
            cache.fetched_at = now
            cache.payload = json.dumps(weather_days, ensure_ascii=False)
        db.commit()
        db.refresh(cache)
        return _cache_payload(cache, "refreshed", days)
    except (httpx.HTTPError, KeyError, ValueError, TypeError) as exc:
        if cache:
            result = _cache_payload(cache, "stale", days)
            result["warning"] = f"天气源暂不可用，返回最近成功缓存：{type(exc).__name__}"
            return result
        raise WeatherUnavailableError(str(exc)) from exc


class WeatherUnavailableError(RuntimeError):
    pass
