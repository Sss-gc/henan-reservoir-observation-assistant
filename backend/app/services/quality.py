from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any

import httpx
import numpy as np
import rasterio
from rasterio.mask import mask
from rasterio.warp import transform_geom
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import SessionLocal
from ..models import ImageryProduct, ProductQualityMetric
from ..repository import get_reservoir


EARTH_SEARCH_ITEM = "https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a/items/{item_id}"
SENTINEL_ID = re.compile(r"^(S2[ABC])_MSIL2A_(\d{8})T\d+_.+_T(\d{2}[A-Z]{3})_")


def utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def earth_search_id(cdse_product_id: str) -> str | None:
    match = SENTINEL_ID.match(cdse_product_id)
    if not match:
        return None
    platform, acquired_date, tile = match.groups()
    return f"{platform}_{tile}_{acquired_date}_0_L2A"


def _scl_counts(scl_url: str, geometry: dict[str, Any]) -> dict[str, int]:
    with rasterio.open(scl_url) as dataset:
        projected = transform_geom("EPSG:4326", dataset.crs, geometry)
        values, _ = mask(dataset, [projected], crop=True, indexes=1, filled=False)
    pixels = values.compressed()
    pixels = pixels[(pixels != 0) & (pixels != 1)]
    return {
        "valid": int(pixels.size),
        "cloud": int(np.isin(pixels, [8, 9, 10]).sum()),
        "shadow": int((pixels == 3).sum()),
        "snow": int((pixels == 11).sum()),
    }


def compute_product_quality(product_record_id: str, force: bool = False) -> dict[str, Any]:
    with SessionLocal() as db:
        product = db.get(ImageryProduct, product_record_id)
        if product is None:
            raise ValueError(f"未找到产品：{product_record_id}")
        if product.source != "copernicus-cdse":
            raise ValueError("Landsat QA_PIXEL 当前需要USGS数据文件授权，尚不能自动计算")
        existing = db.get(ProductQualityMetric, product.id)
        if existing is not None and not force:
            return {
                "product_record_id": product.id,
                "product_id": product.product_id,
                "reservoir_id": product.reservoir_id,
                "computed_at": existing.computed_at,
                "metric_source": existing.metric_source,
                "valid_pixels": existing.valid_pixels,
                "cloud_pixels": existing.cloud_pixels,
                "shadow_pixels": existing.shadow_pixels,
                "snow_pixels": existing.snow_pixels,
                "local_cloud_cover": existing.local_cloud_cover,
                "local_obscured_ratio": existing.local_obscured_ratio,
                "status": existing.status,
                "component_count": len(json.loads(existing.detail).get("sources", [])),
                "cache_status": "hit",
            }
        reservoir = get_reservoir(product.reservoir_id)
        if reservoir is None:
            raise ValueError(f"未找到水库：{product.reservoir_id}")
        raw = json.loads(product.raw_item)
        components = raw.get("components", []) if isinstance(raw, dict) else []
        totals = {"valid": 0, "cloud": 0, "shadow": 0, "snow": 0}
        sources = []
        with httpx.Client(timeout=httpx.Timeout(40.0), follow_redirects=True) as client:
            for component in components:
                item_id = earth_search_id(str(component.get("id", "")))
                if item_id is None:
                    continue
                response = client.get(EARTH_SEARCH_ITEM.format(item_id=item_id))
                response.raise_for_status()
                scl_url = response.json().get("assets", {}).get("scl", {}).get("href")
                if not scl_url:
                    continue
                counts = _scl_counts(str(scl_url), reservoir["geometry"])
                for key in totals:
                    totals[key] += counts[key]
                sources.append({"earth_search_item": item_id, "scl_url": scl_url})
        if totals["valid"] == 0:
            raise ValueError("水库范围内没有有效SCL像元")
        local_cloud = round(totals["cloud"] / totals["valid"] * 100, 2)
        obscured = round(
            (totals["cloud"] + totals["shadow"] + totals["snow"]) / totals["valid"] * 100,
            2,
        )
        metric = db.get(ProductQualityMetric, product.id)
        values = {
            "computed_at": utc_now(),
            "metric_source": "Sentinel-2 L2A SCL 20m / Earth Search COG",
            "valid_pixels": totals["valid"],
            "cloud_pixels": totals["cloud"],
            "shadow_pixels": totals["shadow"],
            "snow_pixels": totals["snow"],
            "local_cloud_cover": local_cloud,
            "local_obscured_ratio": obscured,
            "status": "completed",
            "detail": json.dumps({"sources": sources}, ensure_ascii=False),
        }
        if metric is None:
            metric = ProductQualityMetric(product_record_id=product.id, **values)
            db.add(metric)
        else:
            for key, value in values.items():
                setattr(metric, key, value)
        db.commit()
        return {
            "product_record_id": product.id,
            "product_id": product.product_id,
            "reservoir_id": product.reservoir_id,
            **{key: value for key, value in values.items() if key != "detail"},
            "component_count": len(sources),
        }


def compute_reservoir_quality(reservoir_id: str, limit: int = 3) -> dict[str, Any]:
    with SessionLocal() as db:
        ids = db.scalars(
            select(ImageryProduct.id)
            .where(
                ImageryProduct.reservoir_id == reservoir_id,
                ImageryProduct.source == "copernicus-cdse",
            )
            .order_by(ImageryProduct.acquired_at.desc())
            .limit(limit)
        ).all()
    results, failures = [], []
    for product_id in ids:
        try:
            results.append(compute_product_quality(product_id))
        except Exception as exc:
            failures.append({"product_record_id": product_id, "error": str(exc)})
    return {
        "reservoir_id": reservoir_id,
        "requested": len(ids),
        "completed": len(results),
        "failures": failures,
        "items": results,
    }
