from __future__ import annotations

import json
import hashlib
import io
import time
import uuid
from html import escape
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urljoin

import httpx
from PIL import Image, ImageDraw
from pyproj import CRS, Transformer
from shapely.geometry import mapping, shape
from shapely.ops import transform
from shapely.ops import unary_union
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from ..config import BACKEND_DATA_DIR, COPERNICUS_STAC_URL, IMAGERY_CACHE_TTL_SECONDS, USGS_LANDSAT_STAC_URL
from ..database import SessionLocal
from ..models import ImageryProduct, ProductQualityMetric, TaskRun
from ..repository import get_reservoir, reservoir_collection


SOURCES = (
    {
        "name": "copernicus-cdse",
        "url": f"{COPERNICUS_STAC_URL}/search",
        "collection": "sentinel-2-l2a",
        "resolution_m": 10.0,
    },
    {
        "name": "usgs-landsatlook",
        "url": f"{USGS_LANDSAT_STAC_URL}/search",
        "collection": "landsat-c2l2-sr",
        "resolution_m": 30.0,
    },
)


def utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _parse_datetime(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc).replace(tzinfo=None)


def _bbox(geometry: dict[str, Any]) -> list[float]:
    bounds = shape(geometry).bounds
    return [round(value, 7) for value in bounds]


def _coverage_ratio(reservoir_geometry: dict[str, Any], item_geometry: dict[str, Any], lon: float, lat: float) -> float:
    local_crs = CRS.from_proj4(f"+proj=aeqd +lat_0={lat} +lon_0={lon} +datum=WGS84 +units=m +no_defs")
    transformer = Transformer.from_crs("EPSG:4326", local_crs, always_xy=True)
    reservoir = transform(transformer.transform, shape(reservoir_geometry))
    footprint = transform(transformer.transform, shape(item_geometry))
    if reservoir.area <= 0:
        return 0.0
    return round(max(0.0, min(100.0, reservoir.intersection(footprint).area / reservoir.area * 100)), 2)


def _asset_href(item: dict[str, Any], keys: tuple[str, ...]) -> str | None:
    assets = item.get("assets", {})
    for key in keys:
        asset = assets.get(key)
        if asset and asset.get("href"):
            return str(asset["href"])
    return None


def _catalog_href(item: dict[str, Any]) -> str:
    for link in item.get("links", []):
        if link.get("rel") == "self":
            return str(link["href"])
    return ""


def _search_source(
    client: httpx.Client,
    source: dict[str, Any],
    reservoir: dict[str, Any],
    start: datetime,
    end: datetime,
    limit: int,
) -> list[dict[str, Any]]:
    request_url = source["url"]
    request_method = "POST"
    request_body: dict[str, Any] | None = {
        "collections": [source["collection"]],
        "bbox": _bbox(reservoir["geometry"]),
        "datetime": f"{start.isoformat()}Z/{end.isoformat()}Z",
        "limit": min(100, limit),
        "sortby": [{"field": "properties.datetime", "direction": "desc"}],
    }
    request_headers: dict[str, str] = {}
    items_by_id: dict[str, dict[str, Any]] = {}

    while request_url and len(items_by_id) < limit:
        payload = _request_json(
            client,
            request_method,
            request_url,
            body=request_body,
            headers=request_headers,
        )
        for item in payload.get("features", []):
            item_id = str(item.get("id") or hashlib.sha256(json.dumps(item, sort_keys=True).encode()).hexdigest())
            items_by_id[item_id] = item
            if len(items_by_id) >= limit:
                break

        next_link = next((link for link in payload.get("links", []) if link.get("rel") == "next"), None)
        if not next_link:
            break
        next_href = next_link.get("href")
        if not next_href:
            break
        request_url = urljoin(request_url, str(next_href))
        request_method = str(next_link.get("method", "GET")).upper()
        request_body = next_link.get("body") if request_method != "GET" else None
        request_headers = {str(key): str(value) for key, value in next_link.get("headers", {}).items()}

    return list(items_by_id.values())[:limit]


def _request_json(
    client: httpx.Client,
    method: str,
    url: str,
    body: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    attempts: int = 3,
) -> dict[str, Any]:
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            response = client.request(method, url, json=body, headers=headers)
            if response.status_code == 429 or response.status_code >= 500:
                response.raise_for_status()
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, dict):
                raise ValueError(f"STAC返回了非对象JSON：{url}")
            return payload
        except (httpx.HTTPError, ValueError) as exc:
            last_error = exc
            if attempt + 1 >= attempts:
                break
            retry_after = None
            if isinstance(exc, httpx.HTTPStatusError):
                retry_after = exc.response.headers.get("Retry-After")
            try:
                wait_seconds = min(10.0, float(retry_after)) if retry_after else float(2 ** attempt)
            except ValueError:
                wait_seconds = float(2 ** attempt)
            time.sleep(wait_seconds)
    assert last_error is not None
    raise last_error


def refresh_products(reservoir_id: str, days: int = 90, limit_per_source: int = 20) -> dict[str, Any]:
    reservoir = get_reservoir(reservoir_id)
    if reservoir is None:
        raise ValueError(f"未找到水库：{reservoir_id}")
    canonical_id = reservoir["properties"]["id"]
    task_id = f"imagery-{canonical_id}-{uuid.uuid4().hex[:8]}"
    fetched_at = utc_now()
    start = fetched_at - timedelta(days=days)
    with SessionLocal() as db:
        task = TaskRun(id=task_id, task_name="refresh_imagery", started_at=fetched_at, status="running", detail=canonical_id)
        db.add(task)
        db.commit()
        try:
            saved = 0
            source_counts: dict[str, int] = {}
            warnings: list[str] = []
            with httpx.Client(timeout=httpx.Timeout(60.0), follow_redirects=True) as client:
                for source in SOURCES:
                    try:
                        items = _search_source(client, source, reservoir, start, fetched_at, limit_per_source)
                    except Exception as exc:
                        warnings.append(f"{source['name']}: {exc}")
                        continue
                    db.execute(
                        delete(ImageryProduct).where(
                            ImageryProduct.reservoir_id == canonical_id,
                            ImageryProduct.source == source["name"],
                        )
                    )
                    accepted = 0
                    if source["name"] == "copernicus-cdse":
                        grouped: dict[str, list[dict[str, Any]]] = {}
                        for item in items:
                            props = item.get("properties", {})
                            key = f"{props.get('platform', 'sentinel-2')}:{str(props.get('datetime', ''))[:16]}"
                            grouped.setdefault(key, []).append(item)
                        component_groups = list(grouped.values())
                    else:
                        component_groups = [[item] for item in items]

                    for components in component_groups:
                        item = components[0]
                        combined_geometry = mapping(unary_union([shape(component["geometry"]) for component in components]))
                        coverage = _coverage_ratio(
                            reservoir["geometry"], combined_geometry,
                            reservoir["properties"]["lon"], reservoir["properties"]["lat"],
                        )
                        # "Full coverage" uses a small numerical tolerance for
                        # reprojection and polygon-boundary precision.
                        if coverage < 99.9:
                            continue
                        properties = item.get("properties", {})
                        is_mosaic = len(components) > 1
                        if is_mosaic:
                            acquired_key = str(properties["datetime"]).replace("-", "").replace(":", "")[:13]
                            product_id = f"S2_MOSAIC_{properties.get('platform', 'S2')}_{acquired_key}_{len(components)}TILES"
                        else:
                            product_id = str(item["id"])
                        cloud_values = [
                            float(component.get("properties", {}).get("eo:cloud_cover"))
                            for component in components
                            if component.get("properties", {}).get("eo:cloud_cover") is not None
                        ]
                        raw_payload = {
                            "is_mosaic": is_mosaic,
                            "component_count": len(components),
                            "components": components,
                        }
                        db.add(
                            ImageryProduct(
                                id=f"{canonical_id}:{source['name']}:{product_id}",
                                reservoir_id=canonical_id,
                                product_id=product_id,
                                source=source["name"],
                                collection=str(item.get("collection", source["collection"])),
                                platform=str(properties.get("platform") or properties.get("constellation") or "unknown"),
                                acquired_at=_parse_datetime(properties["datetime"]),
                                cloud_cover=max(cloud_values) if cloud_values else None,
                                coverage_ratio=100.0,
                                resolution_m=source["resolution_m"],
                                thumbnail_url=_asset_href(item, ("thumbnail", "reduced_resolution_browse", "visual")),
                                catalog_url=_catalog_href(item),
                                download_url=None,
                                download_requires_auth=False,
                                fetched_at=fetched_at,
                                raw_item=json.dumps(raw_payload, ensure_ascii=False, separators=(",", ":")),
                            )
                        )
                        accepted += 1
                        saved += 1
                    source_counts[source["name"]] = accepted
            result = {
                "task_id": task_id, "status": "completed", "reservoir_id": canonical_id,
                "days": days, "saved": saved, "sources": source_counts, "warnings": warnings,
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


def products_for_reservoir(db: Session, reservoir_id: str, limit: int = 50) -> dict[str, Any]:
    rows = db.scalars(
        select(ImageryProduct)
        .where(ImageryProduct.reservoir_id == reservoir_id)
        .order_by(ImageryProduct.acquired_at.desc())
        .limit(limit)
    ).all()
    latest = max((row.fetched_at for row in rows), default=None)
    metrics = {
        metric.product_record_id: metric
        for metric in db.scalars(
            select(ProductQualityMetric).where(
                ProductQualityMetric.product_record_id.in_([row.id for row in rows])
            )
        ).all()
    } if rows else {}
    stale = latest is None or (utc_now() - latest).total_seconds() > IMAGERY_CACHE_TTL_SECONDS
    return {
        "cache_status": "missing" if latest is None else "stale" if stale else "fresh",
        "fetched_at": latest.isoformat() + "Z" if latest else None,
        "cloud_metric_scope": "product-footprint metadata; not reservoir-local cloud mask",
        "items": [
            _product_payload(row, metrics.get(row.id))
            for row in rows
        ],
    }


def _product_payload(row: ImageryProduct, metric: ProductQualityMetric | None = None) -> dict[str, Any]:
    raw = json.loads(row.raw_item)
    is_mosaic = bool(raw.get("is_mosaic")) if isinstance(raw, dict) else False
    component_count = int(raw.get("component_count", 1)) if isinstance(raw, dict) else 1
    quality_score = round(100 - metric.local_obscured_ratio) if metric else None
    quality_level = (
        "优质" if quality_score is not None and quality_score >= 80
        else "可用" if quality_score is not None and quality_score >= 60
        else "多云" if quality_score is not None
        else None
    )
    preview_url = f"/api/v1/products/preview/{row.id}"
    return {
                "id": row.id, "product_id": row.product_id, "source": row.source,
                "collection": row.collection, "platform": row.platform,
                "acquired_at": row.acquired_at.isoformat() + "Z",
                "cloud_cover": row.cloud_cover, "coverage_ratio": row.coverage_ratio,
                "resolution_m": row.resolution_m,
                "thumbnail_url": preview_url if is_mosaic else row.thumbnail_url,
                "catalog_url": row.catalog_url,
                "is_mosaic": is_mosaic,
                "component_count": component_count,
                "preview_url": preview_url,
                "local_cloud_cover": metric.local_cloud_cover if metric else None,
                "local_obscured_ratio": metric.local_obscured_ratio if metric else None,
                "local_valid_pixels": metric.valid_pixels if metric else None,
                "quality_metric_source": metric.metric_source if metric else None,
                "quality_computed_at": metric.computed_at.isoformat() + "Z" if metric else None,
                "observation_quality_score": quality_score,
                "observation_quality_level": quality_level,
            }


def product_preview_svg(db: Session, product_record_id: str) -> str | None:
    product = db.get(ImageryProduct, product_record_id)
    if product is None:
        return None
    reservoir = get_reservoir(product.reservoir_id)
    if reservoir is None:
        return None
    geometry = shape(reservoir["geometry"])
    min_x, min_y, max_x, max_y = geometry.bounds
    width = max(max_x - min_x, 1e-9)
    height = max(max_y - min_y, 1e-9)
    padding = 8

    def point(x: float, y: float) -> tuple[float, float]:
        scale = min((120 - 2 * padding) / width, (78 - 2 * padding) / height)
        offset_x = (120 - width * scale) / 2
        offset_y = (78 - height * scale) / 2
        return offset_x + (x - min_x) * scale, offset_y + (max_y - y) * scale

    polygons = list(geometry.geoms) if geometry.geom_type == "MultiPolygon" else [geometry]
    paths = []
    for polygon in polygons:
        coords = [point(x, y) for x, y in polygon.exterior.coords]
        if coords:
            paths.append("M " + " L ".join(f"{x:.1f},{y:.1f}" for x, y in coords) + " Z")
    label = escape(product.platform.replace("_", " "))
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="240" height="156" viewBox="0 0 120 78">
<defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#163b49"/><stop offset="1" stop-color="#071f2b"/></linearGradient></defs>
<rect width="120" height="78" rx="7" fill="url(#bg)"/>
<path d="{' '.join(paths)}" fill="#22d3a7" fill-opacity=".72" stroke="#9cebd7" stroke-width="1"/>
<text x="6" y="11" fill="#dcecf3" font-size="6" font-family="sans-serif">{label}</text>
<text x="6" y="72" fill="#88a9b7" font-size="5" font-family="sans-serif">覆盖示意 · 非影像缩略图</text>
</svg>'''


def _xy_for_bounds(
    x: float, y: float, bounds: tuple[float, float, float, float], width: int, height: int,
) -> tuple[int, int]:
    min_x, min_y, max_x, max_y = bounds
    px = int((x - min_x) / max(max_x - min_x, 1e-9) * width)
    py = int((max_y - y) / max(max_y - min_y, 1e-9) * height)
    return px, py


def _mosaic_preview(product: ImageryProduct, reservoir: dict[str, Any], components: list[dict[str, Any]]) -> bytes:
    cache_dir = BACKEND_DATA_DIR / "product-previews"
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_key = hashlib.sha256(f"{product.id}:{product.fetched_at.isoformat()}".encode()).hexdigest()
    cache_path = cache_dir / f"{cache_key}.png"
    if cache_path.exists():
        return cache_path.read_bytes()

    geometries = [shape(component["geometry"]) for component in components]
    union = unary_union(geometries)
    bounds = union.bounds
    canvas_width, canvas_height = 640, 480
    canvas = Image.new("RGB", (canvas_width, canvas_height), "#071f2b")

    with httpx.Client(timeout=httpx.Timeout(40.0), follow_redirects=True) as client:
        for component, geometry in zip(components, geometries, strict=True):
            thumbnail_url = _asset_href(component, ("thumbnail", "visual", "overview"))
            if not thumbnail_url:
                continue
            response = client.get(thumbnail_url)
            response.raise_for_status()
            tile = Image.open(io.BytesIO(response.content)).convert("RGB")
            min_x, min_y, max_x, max_y = geometry.bounds
            left, top = _xy_for_bounds(min_x, max_y, bounds, canvas_width, canvas_height)
            right, bottom = _xy_for_bounds(max_x, min_y, bounds, canvas_width, canvas_height)
            if right > left and bottom > top:
                canvas.paste(tile.resize((right - left, bottom - top), Image.Resampling.LANCZOS), (left, top))

    overlay = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    water = shape(reservoir["geometry"])
    polygons = list(water.geoms) if water.geom_type == "MultiPolygon" else [water]
    for polygon in polygons:
        points = [_xy_for_bounds(x, y, bounds, canvas_width, canvas_height) for x, y in polygon.exterior.coords]
        if len(points) >= 3:
            draw.polygon(points, fill=(34, 211, 167, 42), outline=(156, 235, 215, 255), width=3)
    draw.rounded_rectangle((10, 10, 245, 42), radius=7, fill=(5, 28, 38, 205))
    draw.text((20, 18), f"{product.platform} · {len(components)} tiles", fill=(220, 242, 245, 255))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), overlay).convert("RGB")
    output = io.BytesIO()
    canvas.save(output, format="PNG", optimize=True)
    payload = output.getvalue()
    cache_path.write_bytes(payload)
    return payload


def product_preview_content(db: Session, product_record_id: str) -> tuple[bytes, str] | None:
    product = db.get(ImageryProduct, product_record_id)
    if product is None:
        return None
    raw = json.loads(product.raw_item)
    components = raw.get("components", []) if isinstance(raw, dict) else []
    if isinstance(raw, dict) and raw.get("is_mosaic") and components:
        reservoir = get_reservoir(product.reservoir_id)
        if reservoir is not None:
            try:
                return _mosaic_preview(product, reservoir, components), "image/png"
            except Exception:
                pass
    svg = product_preview_svg(db, product_record_id)
    return (svg.encode("utf-8"), "image/svg+xml") if svg else None


def refresh_all_products(days: int = 90, limit_per_source: int = 500) -> dict[str, Any]:
    task_id = f"imagery-batch-{uuid.uuid4().hex[:10]}"
    started = utc_now()
    reservoir_ids = [item["properties"]["id"] for item in reservoir_collection()["features"]]
    with SessionLocal() as db:
        db.add(TaskRun(
            id=task_id,
            task_name="refresh_all_imagery",
            started_at=started,
            status="running",
            detail=json.dumps({"completed": 0, "total": len(reservoir_ids)}, ensure_ascii=False),
        ))
        db.commit()

    results = []
    failures = []
    for index, reservoir_id in enumerate(reservoir_ids, start=1):
        try:
            results.append(refresh_products(reservoir_id, days, limit_per_source))
        except Exception as exc:
            failures.append({"reservoir_id": reservoir_id, "error": str(exc)})
        with SessionLocal() as db:
            task = db.get(TaskRun, task_id)
            if task:
                task.detail = json.dumps({
                    "completed": index,
                    "total": len(reservoir_ids),
                    "current_reservoir_id": reservoir_id,
                    "failures": failures,
                }, ensure_ascii=False)
                db.commit()

    summary = {
        "task_id": task_id,
        "status": "completed" if not failures else "completed_with_warnings",
        "completed": len(reservoir_ids),
        "total": len(reservoir_ids),
        "saved": sum(item["saved"] for item in results),
        "failures": failures,
    }
    with SessionLocal() as db:
        task = db.get(TaskRun, task_id)
        if task:
            task.status = summary["status"]
            task.finished_at = utc_now()
            task.detail = json.dumps(summary, ensure_ascii=False)
            db.commit()
    return summary


def imagery_batch_status(db: Session) -> dict[str, Any]:
    task = db.scalar(
        select(TaskRun)
        .where(TaskRun.task_name == "refresh_all_imagery")
        .order_by(TaskRun.started_at.desc())
        .limit(1)
    )
    counts = dict(db.execute(
        select(ImageryProduct.reservoir_id, func.count(ImageryProduct.id))
        .group_by(ImageryProduct.reservoir_id)
    ).all())
    return {
        "latest_task": None if task is None else {
            "id": task.id,
            "status": task.status,
            "started_at": task.started_at.isoformat() + "Z",
            "finished_at": task.finished_at.isoformat() + "Z" if task.finished_at else None,
            "detail": json.loads(task.detail) if task.detail.startswith("{") else task.detail,
        },
        "reservoirs_with_products": len(counts),
        "product_count": sum(counts.values()),
        "counts_by_reservoir": counts,
    }
