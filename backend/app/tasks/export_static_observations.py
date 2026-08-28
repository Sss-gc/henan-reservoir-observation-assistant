from __future__ import annotations

import argparse
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import PROJECT_ROOT
from ..database import Base, SessionLocal, engine
from ..models import Satellite, SatellitePassRecord
from ..repository import reservoir_collection
from ..services.orbit import refresh_orbits


OUTPUT_PATH = PROJECT_ROOT / "public" / "data" / "orbit-passes.json"


def _resolution_m(satellite: Satellite) -> float:
    if satellite.id.startswith("sentinel-2"):
        return 10.0
    if satellite.id.startswith("landsat-"):
        return 30.0
    return 16.0


def build_static_payload(db: Session, days: int = 30) -> dict[str, Any]:
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    end = now + timedelta(days=days)
    rows = db.execute(
        select(SatellitePassRecord, Satellite)
        .join(Satellite, Satellite.id == SatellitePassRecord.satellite_id)
        .where(SatellitePassRecord.center_time_utc.between(now, end))
        .order_by(SatellitePassRecord.center_time_utc, Satellite.name)
    ).all()
    items: list[dict[str, Any]] = []
    latest_epoch: datetime | None = None
    for record, satellite in rows:
        local_time = record.center_time_utc.replace(tzinfo=timezone.utc).astimezone(
            ZoneInfo("Asia/Shanghai")
        )
        latest_epoch = max(latest_epoch, record.element_epoch) if latest_epoch else record.element_epoch
        items.append(
            {
                "id": record.id,
                "reservoir_id": record.reservoir_id,
                "date": local_time.date().isoformat(),
                "time": local_time.strftime("%H:%M"),
                "timezone": "Asia/Shanghai",
                "time_utc": record.center_time_utc.isoformat() + "Z",
                "satellite": satellite.name,
                "sensor": satellite.sensor,
                "resolution_m": _resolution_m(satellite),
                "swath_km": satellite.swath_km,
                "coverage": record.coverage_ratio,
                "min_distance_km": record.min_distance_km,
                "coverage_method": record.coverage_method,
                "element_epoch": record.element_epoch.isoformat() + "Z",
                "confidence": record.confidence,
                "is_imaging_confirmed": False,
            }
        )
    reservoirs = reservoir_collection()["features"]
    covered = {item["reservoir_id"] for item in items}
    return {
        "schema_version": "static-observation-v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "timezone": "Asia/Shanghai",
        "forecast_days": days,
        "source": "CelesTrak OMM + SGP4",
        "element_epoch_latest": latest_epoch.isoformat() + "Z" if latest_epoch else None,
        "coverage_rule": "daylight solar elevation > 10 degrees and reservoir polygon coverage >= 99.9%",
        "coverage_method": "ground-track-swath/polygon-intersection-v2",
        "is_imaging_confirmed": False,
        "warning": "仅表示轨道和传感器幅宽可完整覆盖水库，不代表卫星运营方已确认或排程成像。",
        "reservoir_count": len(reservoirs),
        "reservoirs_with_passes": len(covered),
        "item_count": len(items),
        "items": items,
    }


def write_static_payload(output: Path = OUTPUT_PATH, days: int = 30) -> dict[str, Any]:
    with SessionLocal() as db:
        payload = build_static_payload(db, days)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return payload


def main() -> None:
    parser = argparse.ArgumentParser(description="生成Cloudflare静态站点使用的未来卫星完整覆盖窗口JSON")
    parser.add_argument("--days", type=int, default=30, choices=range(1, 31))
    parser.add_argument("--force", action="store_true", help="强制下载最新CelesTrak OMM")
    parser.add_argument("--skip-refresh", action="store_true", help="直接导出现有轨道计算结果")
    parser.add_argument("--output", type=Path, default=OUTPUT_PATH)
    args = parser.parse_args()
    Base.metadata.create_all(bind=engine)
    refresh_result = None
    if not args.skip_refresh:
        refresh_result = refresh_orbits(days=args.days, force=args.force)
    payload = write_static_payload(args.output.resolve(), args.days)
    print(
        json.dumps(
            {
                "output": str(args.output.resolve()),
                "items": payload["item_count"],
                "reservoirs": payload["reservoirs_with_passes"],
                "refresh": refresh_result,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
