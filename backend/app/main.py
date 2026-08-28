from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timezone
import secrets
from typing import Annotated

from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.orm import Session

from .config import ADMIN_API_KEY, ALLOWED_ORIGINS, APP_VERSION, SCHEDULER_ENABLED
from .database import Base, engine, get_db
from .models import SatellitePassRecord
from .repository import get_reservoir, list_reservoirs, reservoir_collection
from .services.satellite import generate_passes
from .services.orbit import domestic_mission_status, latest_task, list_catalog, refresh_orbits, seed_satellite_catalog, stored_passes
from .services.imagery import (
    imagery_batch_status,
    product_preview_content,
    product_preview_svg,
    products_for_reservoir,
    refresh_all_products,
    refresh_products,
)
from .services.scoring import build_recommendations
from .services.quality import compute_reservoir_quality
from .services.water import compute_reservoir_water, water_series
from .services.admin import admin_overview, recent_tasks
from .services.backup import create_database_backup
from .services.weather import WeatherUnavailableError, get_weather


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(bind=engine)
    reservoir_collection()
    from .database import SessionLocal
    with SessionLocal() as db:
        seed_satellite_catalog(db)
    if SCHEDULER_ENABLED:
        from .scheduler import start_scheduler
        start_scheduler()
    try:
        yield
    finally:
        if SCHEDULER_ENABLED:
            from .scheduler import stop_scheduler
            stop_scheduler()


app = FastAPI(
    title="河南省省控水库遥感观测 API",
    version=APP_VERSION,
    description="为25座省控水库网页提供空间数据、天气缓存、卫星窗口和透明评分接口。",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


def require_reservoir(reservoir_id: str) -> dict:
    reservoir = get_reservoir(reservoir_id)
    if reservoir is None:
        raise HTTPException(status_code=404, detail=f"未找到水库：{reservoir_id}")
    return reservoir


def require_admin(
    admin_key: Annotated[str | None, Header(alias="X-Admin-Key")] = None,
) -> None:
    if not admin_key or not secrets.compare_digest(admin_key, ADMIN_API_KEY):
        raise HTTPException(
            status_code=401,
            detail="需要有效的管理员密钥",
            headers={"WWW-Authenticate": "ApiKey"},
        )


@app.get("/api/v1/health")
def health(db: Session = Depends(get_db)) -> dict:
    db.execute(text("SELECT 1"))
    return {
        "status": "ok",
        "version": APP_VERSION,
        "time_utc": datetime.now(timezone.utc).isoformat(),
        "reservoir_count": len(reservoir_collection()["features"]),
        "database": "sqlite" if str(engine.url).startswith("sqlite") else "external",
        "satellite_data_operational": db.query(SatellitePassRecord).first() is not None,
    }


@app.get("/api/v1/reservoirs")
def reservoirs(include_geometry: bool = Query(True)) -> dict:
    return list_reservoirs(include_geometry=include_geometry)


@app.get("/api/v1/reservoirs/{reservoir_id}")
def reservoir_detail(reservoir_id: str) -> dict:
    return require_reservoir(reservoir_id)


@app.get("/api/v1/reservoirs/{reservoir_id}/weather")
async def reservoir_weather(
    reservoir_id: str,
    days: int = Query(16, ge=1, le=16),
    refresh: bool = Query(False),
    db: Session = Depends(get_db),
) -> dict:
    reservoir = require_reservoir(reservoir_id)
    try:
        result = await get_weather(db, reservoir, days, force_refresh=refresh)
    except WeatherUnavailableError as exc:
        raise HTTPException(status_code=503, detail=f"天气数据暂不可用：{exc}") from exc
    return {"reservoir": reservoir["properties"], **result}


@app.get("/api/v1/reservoirs/{reservoir_id}/passes")
def reservoir_passes(
    reservoir_id: str,
    days: int = Query(30, ge=1, le=30),
    db: Session = Depends(get_db),
) -> dict:
    reservoir = require_reservoir(reservoir_id)
    real_items = stored_passes(db, reservoir["properties"]["id"], days)
    if real_items:
        return {
            "reservoir": reservoir["properties"],
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "operational": True,
            "data_mode": "orbit_prediction",
            "is_imaging_confirmed": False,
            "items": real_items,
        }
    return {
        "reservoir": reservoir["properties"],
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "operational": False,
        "data_mode": "demonstration_prediction",
        "items": generate_passes(reservoir, days=days),
    }


@app.get("/api/v1/reservoirs/{reservoir_id}/recommendations")
async def reservoir_recommendations(
    reservoir_id: str,
    days: int = Query(30, ge=1, le=30),
    db: Session = Depends(get_db),
) -> dict:
    reservoir = require_reservoir(reservoir_id)
    passes = stored_passes(db, reservoir["properties"]["id"], days) or generate_passes(reservoir, days=days)
    try:
        weather_result = await get_weather(db, reservoir, min(days, 16))
        weather_days = weather_result["days"]
        weather_status = weather_result["cache_status"]
    except WeatherUnavailableError:
        weather_days = []
        weather_status = "unavailable"
    return {
        "reservoir": reservoir["properties"],
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "operational": bool(passes and passes[0].get("source_type") == "orbit_prediction"),
        "weather_cache_status": weather_status,
        "items": build_recommendations(passes, weather_days),
    }


@app.get("/api/v1/calendar")
def calendar(
    days: int = Query(7, ge=1, le=30),
    limit: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db),
) -> dict:
    items = []
    using_real = False
    for reservoir in reservoir_collection()["features"]:
        passes = stored_passes(db, reservoir["properties"]["id"], days)
        if passes:
            using_real = True
        else:
            passes = generate_passes(reservoir, days=days)
        for satellite_pass in passes:
            items.append(
                {
                    **satellite_pass,
                    "reservoir_name": reservoir["properties"]["name_cn"],
                }
            )
    items.sort(key=lambda item: (item["date"], item["time"], item["reservoir_name"]))
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "operational": using_real,
        "total": len(items),
        "items": items[:limit],
    }


@app.get("/api/v1/satellites")
def satellites(db: Session = Depends(get_db)) -> dict:
    return {"source": "CelesTrak GP/OMM", "items": list_catalog(db)}


@app.get("/api/v1/domestic-satellites")
def domestic_satellites(db: Session = Depends(get_db)) -> dict:
    return domestic_mission_status(db)


@app.get("/api/v1/orbits/status")
def orbit_status(db: Session = Depends(get_db)) -> dict:
    return {"latest_task": latest_task(db), "satellites": list_catalog(db)}


@app.post("/api/v1/orbits/refresh", status_code=202)
def orbit_refresh(
    background_tasks: BackgroundTasks,
    days: int = Query(7, ge=1, le=30),
    force: bool = Query(False),
    db: Session = Depends(get_db),
    _: None = Depends(require_admin),
) -> dict:
    current = latest_task(db)
    if current and current["status"] == "running":
        return {"accepted": False, "reason": "已有刷新任务正在运行", "task": current}
    background_tasks.add_task(refresh_orbits, days, force)
    return {"accepted": True, "status": "queued", "days": days, "force": force}


@app.get("/api/v1/reservoirs/{reservoir_id}/products")
def reservoir_products(
    reservoir_id: str,
    limit: int = Query(50, ge=1, le=1000),
    db: Session = Depends(get_db),
) -> dict:
    reservoir = require_reservoir(reservoir_id)
    return {
        "reservoir": reservoir["properties"],
        **products_for_reservoir(db, reservoir["properties"]["id"], limit),
    }


@app.post("/api/v1/reservoirs/{reservoir_id}/products/refresh")
def refresh_reservoir_products(
    reservoir_id: str,
    days: int = Query(90, ge=1, le=365),
    limit_per_source: int = Query(200, ge=1, le=1000),
    _: None = Depends(require_admin),
) -> dict:
    reservoir = require_reservoir(reservoir_id)
    result = refresh_products(reservoir["properties"]["id"], days, limit_per_source)
    from .database import SessionLocal
    with SessionLocal() as db:
        products = products_for_reservoir(db, reservoir["properties"]["id"], min(limit_per_source * 2, 1000))
    return {"refresh": result, "reservoir": reservoir["properties"], **products}


@app.post("/api/v1/reservoirs/{reservoir_id}/quality/refresh")
def refresh_reservoir_quality(
    reservoir_id: str,
    limit: int = Query(3, ge=1, le=20),
    _: None = Depends(require_admin),
) -> dict:
    reservoir = require_reservoir(reservoir_id)
    return compute_reservoir_quality(reservoir["properties"]["id"], limit)


@app.get("/api/v1/reservoirs/{reservoir_id}/water-series")
def reservoir_water_series(reservoir_id: str) -> dict:
    reservoir = require_reservoir(reservoir_id)
    return {
        "reservoir": reservoir["properties"],
        **water_series(reservoir["properties"]["id"]),
    }


@app.post("/api/v1/reservoirs/{reservoir_id}/water/refresh")
def refresh_reservoir_water(
    reservoir_id: str,
    limit: int = Query(3, ge=1, le=20),
    force: bool = Query(False),
    _: None = Depends(require_admin),
) -> dict:
    reservoir = require_reservoir(reservoir_id)
    return compute_reservoir_water(reservoir["properties"]["id"], limit, force)


@app.get("/api/v1/products/{product_record_id:path}/preview.svg")
def product_preview(product_record_id: str, db: Session = Depends(get_db)) -> Response:
    svg = product_preview_svg(db, product_record_id)
    if svg is None:
        raise HTTPException(status_code=404, detail="未找到产品预览")
    return Response(content=svg, media_type="image/svg+xml", headers={"Cache-Control": "public, max-age=86400"})


@app.get("/api/v1/products/preview/{product_record_id:path}")
def rendered_product_preview(product_record_id: str, db: Session = Depends(get_db)) -> Response:
    preview = product_preview_content(db, product_record_id)
    if preview is None:
        raise HTTPException(status_code=404, detail="未找到产品预览")
    content, media_type = preview
    return Response(content=content, media_type=media_type, headers={"Cache-Control": "public, max-age=86400"})


@app.get("/api/v1/imagery/status")
def imagery_status(
    db: Session = Depends(get_db),
    _: None = Depends(require_admin),
) -> dict:
    return imagery_batch_status(db)


@app.post("/api/v1/imagery/refresh-all", status_code=202)
def refresh_all_imagery(
    background_tasks: BackgroundTasks,
    days: int = Query(90, ge=1, le=365),
    limit_per_source: int = Query(500, ge=1, le=1000),
    db: Session = Depends(get_db),
    _: None = Depends(require_admin),
) -> dict:
    status = imagery_batch_status(db)
    current = status["latest_task"]
    if current and current["status"] == "running":
        return {"accepted": False, "reason": "已有批量影像刷新任务正在运行", "task": current}
    background_tasks.add_task(refresh_all_products, days, limit_per_source)
    return {"accepted": True, "status": "queued", "days": days, "limit_per_source": limit_per_source}


@app.get("/api/v1/scheduler/status")
def scheduler_status() -> dict:
    if not SCHEDULER_ENABLED:
        return {"enabled": False, "running": False, "jobs": []}
    from .scheduler import scheduler_snapshot
    return scheduler_snapshot()


@app.get("/api/v1/admin/auth-status")
def administration_auth_status() -> dict:
    return {"required": True, "method": "X-Admin-Key", "session_storage_only": True}


@app.get("/api/v1/admin/overview")
def administration_overview(
    db: Session = Depends(get_db),
    _: None = Depends(require_admin),
) -> dict:
    return admin_overview(db)


@app.get("/api/v1/admin/tasks")
def administration_tasks(
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    _: None = Depends(require_admin),
) -> dict:
    items = recent_tasks(db, limit)
    return {"count": len(items), "items": items}


@app.post("/api/v1/admin/backup")
def administration_backup(_: None = Depends(require_admin)) -> dict:
    return {"accepted": True, "backup": create_database_backup()}
