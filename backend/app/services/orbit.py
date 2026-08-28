from __future__ import annotations

import json
import math
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

import httpx
import numpy as np
from pyproj import CRS, Transformer
from shapely.geometry import LineString, shape
from shapely.ops import transform
from sqlalchemy import delete, select
from sqlalchemy.orm import Session
from skyfield.api import EarthSatellite, load, wgs84

from ..config import CELESTRAK_GP_URL, ORBIT_CACHE_TTL_SECONDS
from ..database import SessionLocal
from ..models import OrbitalElement, Satellite, SatellitePassRecord, TaskRun
from ..repository import reservoir_collection
from ..satellite_catalog import CELESTRAK_RESOURCE_TABLE, DOMESTIC_MISSION_METADATA, SATELLITE_CATALOG


def utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def seed_satellite_catalog(db: Session) -> None:
    for item in SATELLITE_CATALOG:
        satellite = db.get(Satellite, item["id"])
        values = {**item, "source_url": CELESTRAK_RESOURCE_TABLE}
        if satellite is None:
            db.add(Satellite(**values))
        else:
            for key, value in values.items():
                setattr(satellite, key, value)
    db.commit()


def list_catalog(db: Session) -> list[dict[str, Any]]:
    seed_satellite_catalog(db)
    rows = db.scalars(select(Satellite).order_by(Satellite.name)).all()
    latest: dict[str, datetime] = {}
    for satellite_id, fetched_at in db.execute(
        select(OrbitalElement.satellite_id, OrbitalElement.fetched_at)
        .order_by(OrbitalElement.fetched_at.desc())
    ).all():
        latest.setdefault(satellite_id, fetched_at)
    return [
        {
            "id": row.id,
            "name": row.name,
            "norad_cat_id": row.norad_cat_id,
            "intl_designator": row.intl_designator,
            "sensor": row.sensor,
            "swath_km": row.swath_km,
            "prediction_enabled": row.prediction_enabled,
            "catalog_status": row.catalog_status,
            "orbit_cached_at": latest.get(row.id).isoformat() + "Z" if latest.get(row.id) else None,
            "source_url": row.source_url,
            **DOMESTIC_MISSION_METADATA.get(row.id, {}),
        }
        for row in rows
    ]


def domestic_mission_status(db: Session) -> dict[str, Any]:
    items = [item for item in list_catalog(db) if item["id"] in DOMESTIC_MISSION_METADATA]
    return {
        "prediction_method": "CelesTrak OMM + SGP4 + 800km conservative wide-view corridor + reservoir polygon intersection",
        "is_imaging_confirmed": False,
        "actual_product_query": "official account portal link only; no documented anonymous catalog API found",
        "items": items,
    }


def _parse_epoch(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc).replace(tzinfo=None)


def _latest_element(db: Session, satellite_id: str) -> OrbitalElement | None:
    return db.scalar(
        select(OrbitalElement)
        .where(OrbitalElement.satellite_id == satellite_id)
        .order_by(OrbitalElement.fetched_at.desc())
        .limit(1)
    )


def _download_omm(client: httpx.Client, satellite: Satellite) -> tuple[dict[str, Any], str]:
    response = client.get(
        CELESTRAK_GP_URL,
        params={"CATNR": satellite.norad_cat_id, "FORMAT": "JSON"},
    )
    response.raise_for_status()
    payload = response.json()
    if not payload or str(payload[0].get("NORAD_CAT_ID")) != str(satellite.norad_cat_id):
        raise ValueError(f"CelesTrak 未返回 NORAD {satellite.norad_cat_id} 的有效 OMM")
    return payload[0], str(response.url)


def _haversine_km(lats: np.ndarray, lons: np.ndarray, lat: float, lon: float) -> np.ndarray:
    radius = 6371.0088
    lat1 = np.radians(lats)
    lat2 = math.radians(lat)
    dlat = lat1 - lat2
    dlon = np.radians(((lons - lon + 180.0) % 360.0) - 180.0)
    value = np.sin(dlat / 2) ** 2 + np.cos(lat1) * math.cos(lat2) * np.sin(dlon / 2) ** 2
    return radius * 2 * np.arcsin(np.minimum(1.0, np.sqrt(value)))


def _groups(indices: np.ndarray) -> list[np.ndarray]:
    if indices.size == 0:
        return []
    return np.split(indices, np.where(np.diff(indices) > 1)[0] + 1)


def _solar_direction_enu(
    moment: datetime, latitude: float, longitude: float
) -> tuple[float, float, np.ndarray]:
    """Return NOAA-approximate solar elevation, azimuth and local ENU unit vector."""
    aware = moment.replace(tzinfo=timezone.utc)
    day = aware.timetuple().tm_yday
    hour = aware.hour + aware.minute / 60 + aware.second / 3600
    gamma = 2 * math.pi / 365 * (day - 1 + (hour - 12) / 24)
    equation_of_time = 229.18 * (
        0.000075 + 0.001868 * math.cos(gamma) - 0.032077 * math.sin(gamma)
        - 0.014615 * math.cos(2 * gamma) - 0.040849 * math.sin(2 * gamma)
    )
    declination = (
        0.006918 - 0.399912 * math.cos(gamma) + 0.070257 * math.sin(gamma)
        - 0.006758 * math.cos(2 * gamma) + 0.000907 * math.sin(2 * gamma)
        - 0.002697 * math.cos(3 * gamma) + 0.00148 * math.sin(3 * gamma)
    )
    true_solar_minutes = (hour * 60 + equation_of_time + 4 * longitude) % 1440
    hour_angle = math.radians(true_solar_minutes / 4 - 180)
    lat_rad = math.radians(latitude)
    up = (
        math.sin(lat_rad) * math.sin(declination)
        + math.cos(lat_rad) * math.cos(declination) * math.cos(hour_angle)
    )
    east = -math.cos(declination) * math.sin(hour_angle)
    north = (
        math.cos(lat_rad) * math.sin(declination)
        - math.sin(lat_rad) * math.cos(declination) * math.cos(hour_angle)
    )
    vector = np.asarray([east, north, up], dtype=float)
    vector /= np.linalg.norm(vector)
    elevation = math.degrees(math.asin(max(-1.0, min(1.0, float(vector[2])))))
    azimuth = math.degrees(math.atan2(float(vector[0]), float(vector[1]))) % 360.0
    return elevation, azimuth, vector


def _glint_risk(angle_deg: float) -> str:
    """Conservative tiers inside NASA's commonly used 40-degree glint region."""
    if angle_deg < 10.0:
        return "high"
    if angle_deg < 20.0:
        return "medium"
    if angle_deg < 40.0:
        return "low"
    return "minimal"


def _glint_geometry(
    satellite_object: EarthSatellite,
    skyfield_time: Any,
    moment: datetime,
    latitude: float,
    longitude: float,
) -> dict[str, float | str]:
    """Estimate flat-water specular geometry at a reservoir in local ENU coordinates."""
    solar_elevation, solar_azimuth, sun_vector = _solar_direction_enu(
        moment, latitude, longitude
    )
    observer = wgs84.latlon(latitude, longitude)
    altitude, azimuth, _ = (satellite_object - observer).at(skyfield_time).altaz()
    satellite_elevation = float(altitude.degrees)
    satellite_azimuth = float(azimuth.degrees) % 360.0
    elevation_rad = math.radians(satellite_elevation)
    azimuth_rad = math.radians(satellite_azimuth)
    view_vector = np.asarray(
        [
            math.cos(elevation_rad) * math.sin(azimuth_rad),
            math.cos(elevation_rad) * math.cos(azimuth_rad),
            math.sin(elevation_rad),
        ],
        dtype=float,
    )
    # A horizontal surface reverses the horizontal part of the incoming sun ray.
    reflected_sun = np.asarray([-sun_vector[0], -sun_vector[1], sun_vector[2]])
    cosine = float(np.clip(np.dot(reflected_sun, view_vector), -1.0, 1.0))
    glint_angle = math.degrees(math.acos(cosine))
    return {
        "solar_elevation_deg": round(solar_elevation, 2),
        "solar_azimuth_deg": round(solar_azimuth, 2),
        "satellite_elevation_deg": round(satellite_elevation, 2),
        "satellite_azimuth_deg": round(satellite_azimuth, 2),
        "glint_angle_deg": round(glint_angle, 2),
        "glint_risk": _glint_risk(glint_angle),
    }


def _predict_satellite(
    db: Session,
    satellite: Satellite,
    omm: dict[str, Any],
    element_epoch: datetime,
    start: datetime,
    days: int,
    created_at: datetime,
) -> int:
    step_seconds = 30
    count = int(days * 86400 / step_seconds) + 1
    datetimes = [
        (start + timedelta(seconds=index * step_seconds)).replace(tzinfo=timezone.utc)
        for index in range(count)
    ]
    ts = load.timescale(builtin=True)
    satellite_object = EarthSatellite.from_omm(ts, omm)
    skyfield_times = ts.from_datetimes(datetimes)
    positions = satellite_object.at(skyfield_times)
    subpoints = wgs84.subpoint_of(positions)
    lats = np.asarray(subpoints.latitude.degrees)
    lons = np.asarray(subpoints.longitude.degrees)
    written = 0

    for reservoir in reservoir_collection()["features"]:
        props = reservoir["properties"]
        radius_km = math.sqrt(max(float(props["area_km2"]), 0.01) / math.pi)
        half_swath = float(satellite.swath_km or 0) / 2
        local_crs = CRS.from_proj4(
            f"+proj=aeqd +lat_0={props['lat']} +lon_0={props['lon']} +datum=WGS84 +units=m +no_defs"
        )
        transformer = Transformer.from_crs("EPSG:4326", local_crs, always_xy=True)
        reservoir_local = transform(transformer.transform, shape(reservoir["geometry"]))
        distances = _haversine_km(lats, lons, float(props["lat"]), float(props["lon"]))
        candidates = np.flatnonzero(distances <= half_swath + radius_km)
        for group in _groups(candidates):
            center_index = int(group[np.argmin(distances[group])])
            minimum = float(distances[center_index])
            center = datetimes[center_index].replace(tzinfo=None)
            glint = _glint_geometry(
                satellite_object,
                skyfield_times[center_index],
                center,
                float(props["lat"]),
                float(props["lon"]),
            )
            if float(glint["solar_elevation_deg"]) <= 10.0:
                continue
            track_start = max(0, center_index - 10)
            track_end = min(count, center_index + 11)
            track_wgs84 = LineString(
                [(float(lons[index]), float(lats[index])) for index in range(track_start, track_end)]
            )
            swath_corridor = transform(transformer.transform, track_wgs84).buffer(
                half_swath * 1000,
                cap_style="flat",
                join_style="round",
            )
            coverage = (
                reservoir_local.intersection(swath_corridor).area / reservoir_local.area * 100
                if reservoir_local.area > 0 else 0.0
            )
            if coverage < 99.9:
                continue
            coverage = 100.0
            record_id = f"{props['id']}:{satellite.id}:{center.strftime('%Y%m%dT%H%M%S')}"
            db.add(
                SatellitePassRecord(
                    id=record_id,
                    reservoir_id=props["id"],
                    satellite_id=satellite.id,
                    start_time_utc=datetimes[int(group[0])].replace(tzinfo=None),
                    center_time_utc=center,
                    end_time_utc=datetimes[int(group[-1])].replace(tzinfo=None),
                    min_distance_km=round(minimum, 3),
                    coverage_ratio=round(coverage, 1),
                    element_epoch=element_epoch,
                    created_at=created_at,
                    confidence="B",
                    coverage_method="ground-track-swath/polygon-intersection-v2",
                    **glint,
                )
            )
            written += 1
    return written


def refresh_orbits(days: int = 7, force: bool = False) -> dict[str, Any]:
    task_id = f"orbit-{uuid.uuid4().hex[:12]}"
    started = utc_now()
    with SessionLocal() as db:
        seed_satellite_catalog(db)
        task = TaskRun(id=task_id, task_name="refresh_orbits", started_at=started, status="running", detail="")
        db.add(task)
        db.commit()
        try:
            satellites = db.scalars(select(Satellite).where(Satellite.prediction_enabled.is_(True))).all()
            elements: list[tuple[Satellite, dict[str, Any], datetime, str]] = []
            downloads = 0
            cached = 0
            errors: list[str] = []
            with httpx.Client(timeout=httpx.Timeout(25.0), follow_redirects=True) as client:
                for satellite in satellites:
                    prior = _latest_element(db, satellite.id)
                    fresh = prior and (started - prior.fetched_at).total_seconds() < ORBIT_CACHE_TTL_SECONDS
                    if prior and fresh and not force:
                        elements.append((satellite, json.loads(prior.payload), prior.epoch, prior.source_url))
                        cached += 1
                        continue
                    try:
                        omm, source_url = _download_omm(client, satellite)
                        epoch = _parse_epoch(omm["EPOCH"])
                        db.add(
                            OrbitalElement(
                                satellite_id=satellite.id,
                                epoch=epoch,
                                fetched_at=started,
                                source_format="OMM_JSON",
                                source_url=source_url,
                                payload=json.dumps(omm, ensure_ascii=False, separators=(",", ":")),
                            )
                        )
                        elements.append((satellite, omm, epoch, source_url))
                        downloads += 1
                    except Exception as exc:
                        if prior:
                            elements.append((satellite, json.loads(prior.payload), prior.epoch, prior.source_url))
                            cached += 1
                            errors.append(f"{satellite.name}: 下载失败，使用旧缓存（{exc}）")
                        else:
                            errors.append(f"{satellite.name}: {exc}")
            db.flush()
            db.execute(delete(SatellitePassRecord).where(SatellitePassRecord.center_time_utc >= started))
            passes = sum(
                _predict_satellite(db, satellite, omm, epoch, started, days, started)
                for satellite, omm, epoch, _ in elements
            )
            result = {
                "task_id": task_id, "status": "completed", "days": days,
                "satellites": len(elements), "downloaded": downloads, "cached": cached,
                "passes": passes, "warnings": errors,
            }
            task.status = "completed"
            task.finished_at = utc_now()
            task.detail = json.dumps(result, ensure_ascii=False)
            db.commit()
            return result
        except Exception as exc:
            db.rollback()
            failed = db.get(TaskRun, task_id)
            if failed:
                failed.status = "failed"
                failed.finished_at = utc_now()
                failed.detail = str(exc)
                db.commit()
            raise


def latest_task(db: Session) -> dict[str, Any] | None:
    task = db.scalar(select(TaskRun).where(TaskRun.task_name == "refresh_orbits").order_by(TaskRun.started_at.desc()).limit(1))
    if task is None:
        return None
    return {
        "id": task.id, "status": task.status,
        "started_at": task.started_at.isoformat() + "Z",
        "finished_at": task.finished_at.isoformat() + "Z" if task.finished_at else None,
        "detail": json.loads(task.detail) if task.detail.startswith("{") else task.detail,
    }


def stored_passes(db: Session, reservoir_id: str, days: int) -> list[dict[str, Any]]:
    now = utc_now()
    end = now + timedelta(days=days)
    rows = db.execute(
        select(SatellitePassRecord, Satellite)
        .join(Satellite, Satellite.id == SatellitePassRecord.satellite_id)
        .where(
            SatellitePassRecord.reservoir_id == reservoir_id,
            SatellitePassRecord.center_time_utc.between(now, end),
        )
        .order_by(SatellitePassRecord.center_time_utc)
    ).all()
    items = []
    for record, satellite in rows:
        local_time = record.center_time_utc.replace(tzinfo=timezone.utc).astimezone(ZoneInfo("Asia/Shanghai"))
        items.append({
            "id": record.id,
            "reservoir_id": record.reservoir_id,
            "date": local_time.date().isoformat(),
            "time": local_time.strftime("%H:%M"),
            "timezone": "Asia/Shanghai",
            "time_utc": record.center_time_utc.isoformat() + "Z",
            "start_time_utc": record.start_time_utc.isoformat() + "Z",
            "end_time_utc": record.end_time_utc.isoformat() + "Z",
            "satellite": satellite.name,
            "confidence": record.confidence,
            "source_type": "orbit_prediction",
            "sourceLabel": "轨道几何预测",
            "coverage": record.coverage_ratio,
            "min_distance_km": record.min_distance_km,
            "coverage_method": record.coverage_method,
            "element_epoch": record.element_epoch.isoformat() + "Z",
            "solar_elevation_deg": record.solar_elevation_deg,
            "solar_azimuth_deg": record.solar_azimuth_deg,
            "satellite_elevation_deg": record.satellite_elevation_deg,
            "satellite_azimuth_deg": record.satellite_azimuth_deg,
            "glint_angle_deg": record.glint_angle_deg,
            "glint_risk": record.glint_risk,
            "is_operational": True,
            "is_imaging_confirmed": False,
            "warning": "已按太阳高度角>10°且完整水库几何覆盖率≥99.9%筛选；耀光为平静水平水面的几何风险估计，不代表卫星已排程成像。",
        })
    return items
