from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import distinct, func, select
from sqlalchemy.orm import Session

from ..config import BACKEND_DATA_DIR, SCHEDULER_ENABLED
from ..database import engine
from ..models import (
    ImageryProduct,
    OrbitalElement,
    ProductQualityMetric,
    ProductWaterMetric,
    SatellitePassRecord,
    TaskRun,
    WeatherCache,
)
from ..repository import reservoir_collection
from .backup import database_backup_status


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() + "Z" if value else None


def _detail(value: str) -> Any:
    try:
        return json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return value


def task_payload(task: TaskRun) -> dict[str, Any]:
    detail = _detail(task.detail)
    failures = detail.get("failures", []) if isinstance(detail, dict) else []
    warnings = detail.get("warnings", []) if isinstance(detail, dict) else []
    return {
        "id": task.id,
        "task_name": task.task_name,
        "status": task.status,
        "started_at": _iso(task.started_at),
        "finished_at": _iso(task.finished_at),
        "duration_seconds": round((task.finished_at - task.started_at).total_seconds(), 1)
        if task.finished_at else None,
        "failure_count": len(failures) + len(warnings),
        "detail": detail,
    }


def recent_tasks(db: Session, limit: int = 20) -> list[dict[str, Any]]:
    rows = db.scalars(select(TaskRun).order_by(TaskRun.started_at.desc()).limit(limit)).all()
    return [task_payload(task) for task in rows]


def recent_problem_tasks(db: Session, limit: int = 10) -> list[dict[str, Any]]:
    rows = db.scalars(select(TaskRun).order_by(TaskRun.started_at.desc()).limit(200)).all()
    results = []
    for task in rows:
        payload = task_payload(task)
        if task.status not in {"completed"} or payload["failure_count"] > 0:
            results.append(payload)
        if len(results) >= limit:
            break
    return results


def _directory_stats(path: Path, pattern: str = "*") -> dict[str, int]:
    files = [item for item in path.glob(pattern) if item.is_file()] if path.exists() else []
    return {"file_count": len(files), "bytes": sum(item.stat().st_size for item in files)}


def admin_overview(db: Session) -> dict[str, Any]:
    product_sources = dict(db.execute(
        select(ImageryProduct.source, func.count(ImageryProduct.id)).group_by(ImageryProduct.source)
    ).all())
    task_statuses = dict(db.execute(
        select(TaskRun.status, func.count(TaskRun.id)).group_by(TaskRun.status)
    ).all())
    database_path = Path(str(engine.url.database)) if engine.url.database else None
    database_bytes = database_path.stat().st_size if database_path and database_path.exists() else None
    preview_stats = _directory_stats(BACKEND_DATA_DIR / "product-previews")
    scheduler = {"enabled": False, "running": False, "jobs": []}
    if SCHEDULER_ENABLED:
        from ..scheduler import scheduler_snapshot
        scheduler = scheduler_snapshot()
    latest_product_fetch = db.scalar(select(func.max(ImageryProduct.fetched_at)))
    latest_orbit_fetch = db.scalar(select(func.max(OrbitalElement.fetched_at)))
    latest_water = db.scalar(select(func.max(ProductWaterMetric.computed_at)))
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "scheduler": scheduler,
        "counts": {
            "reservoirs": len(reservoir_collection()["features"]),
            "imagery_products": db.scalar(select(func.count(ImageryProduct.id))) or 0,
            "reservoirs_with_products": db.scalar(select(func.count(distinct(ImageryProduct.reservoir_id)))) or 0,
            "satellite_passes": db.scalar(select(func.count(SatellitePassRecord.id))) or 0,
            "weather_caches": db.scalar(select(func.count(WeatherCache.reservoir_id))) or 0,
            "quality_metrics": db.scalar(select(func.count(ProductQualityMetric.product_record_id))) or 0,
            "water_metrics": db.scalar(select(func.count(ProductWaterMetric.product_record_id))) or 0,
            "reservoirs_with_water_metrics": db.scalar(select(func.count(distinct(ImageryProduct.reservoir_id))).join(
                ProductWaterMetric, ProductWaterMetric.product_record_id == ImageryProduct.id
            )) or 0,
        },
        "product_sources": product_sources,
        "task_statuses": task_statuses,
        "storage": {
            "database_bytes": database_bytes,
            "database_path": str(database_path) if database_path else None,
            "preview_cache": preview_stats,
            "database_backups": database_backup_status(),
        },
        "freshness": {
            "latest_product_fetch": _iso(latest_product_fetch),
            "latest_orbit_fetch": _iso(latest_orbit_fetch),
            "latest_water_analysis": _iso(latest_water),
        },
        "recent_tasks": recent_tasks(db, 12),
        "problem_tasks": recent_problem_tasks(db, 10),
    }
