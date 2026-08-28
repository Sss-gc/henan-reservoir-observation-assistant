from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

import httpx
import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.features import geometry_mask, geometry_window
from rasterio.transform import array_bounds
from rasterio.windows import from_bounds
from rasterio.warp import transform_geom
from shapely.geometry import GeometryCollection, mapping, shape
from sqlalchemy import select

from ..database import SessionLocal
from ..models import ImageryProduct, ProductWaterMetric
from ..repository import get_reservoir
from .quality import EARTH_SEARCH_ITEM, earth_search_id


METHOD = "Sentinel-2 L2A 20m; SCL clear mask; NDWI/MNDWI>0; clear-pixel fraction normalized to SHP reference extent"
CLEAR_SCL = {2, 4, 5, 6, 7}


def utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _scale_offset(asset: dict[str, Any]) -> tuple[float, float]:
    bands = asset.get("raster:bands") or []
    band = bands[0] if bands else {}
    return float(band.get("scale", 0.0001)), float(band.get("offset", -0.1))


def _read_to_grid(
    dataset: Any,
    bounds: tuple[float, float, float, float],
    shape_: tuple[int, int],
) -> np.ma.MaskedArray:
    window = from_bounds(*bounds, transform=dataset.transform)
    return np.ma.asarray(dataset.read(
        1,
        window=window,
        out_shape=shape_,
        resampling=Resampling.bilinear,
        masked=True,
        boundless=True,
        fill_value=dataset.nodata or 0,
    ))


def _component_metrics(assets: dict[str, Any], geometry: dict[str, Any]) -> dict[str, float | int]:
    required = {key: assets.get(key) for key in ("green", "nir", "swir16", "scl")}
    if any(not asset or not asset.get("href") for asset in required.values()):
        raise ValueError("Earth Search条目缺少green/nir/swir16/scl资产")

    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", AWS_NO_SIGN_REQUEST="YES"):
        with rasterio.open(required["scl"]["href"]) as scl_ds, \
             rasterio.open(required["green"]["href"]) as green_ds, \
             rasterio.open(required["nir"]["href"]) as nir_ds, \
             rasterio.open(required["swir16"]["href"]) as swir_ds:
            projected = transform_geom("EPSG:4326", scl_ds.crs, geometry)
            window = geometry_window(scl_ds, [projected])
            scl = np.ma.asarray(scl_ds.read(1, window=window, masked=True))
            out_transform = scl_ds.window_transform(window)
            height, width = scl.shape
            bounds = array_bounds(height, width, out_transform)
            target_shape = (height, width)
            green = _read_to_grid(green_ds, bounds, target_shape)
            nir = _read_to_grid(nir_ds, bounds, target_shape)
            swir = _read_to_grid(swir_ds, bounds, target_shape)
            inside = geometry_mask(
                [projected],
                out_shape=target_shape,
                transform=out_transform,
                invert=True,
            )
            pixel_area_km2 = abs(out_transform.a * out_transform.e) / 1_000_000

    green_scale, green_offset = _scale_offset(required["green"])
    nir_scale, nir_offset = _scale_offset(required["nir"])
    swir_scale, swir_offset = _scale_offset(required["swir16"])
    green_values = green.data.astype("float32") * green_scale + green_offset
    nir_values = nir.data.astype("float32") * nir_scale + nir_offset
    swir_values = swir.data.astype("float32") * swir_scale + swir_offset
    # L2A offset can produce small negative reflectance for very dark pixels.
    # Physical reflectance is non-negative; clipping also keeps normalized
    # difference indices within their expected [-1, 1] interval.
    green_values = np.maximum(green_values, 0)
    nir_values = np.maximum(nir_values, 0)
    swir_values = np.maximum(swir_values, 0)
    combined_mask = ~inside | np.ma.getmaskarray(scl) | np.ma.getmaskarray(green) | np.ma.getmaskarray(nir) | np.ma.getmaskarray(swir)
    valid = ~combined_mask & ~np.isin(scl.data, [0, 1])
    clear = valid & np.isin(scl.data, list(CLEAR_SCL))
    ndwi_denominator = green_values + nir_values
    mndwi_denominator = green_values + swir_values
    index_valid = clear & (np.abs(ndwi_denominator) > 1e-6) & (np.abs(mndwi_denominator) > 1e-6)
    ndwi = np.zeros(green_values.shape, dtype="float32")
    mndwi = np.zeros(green_values.shape, dtype="float32")
    ndwi[index_valid] = (green_values[index_valid] - nir_values[index_valid]) / ndwi_denominator[index_valid]
    mndwi[index_valid] = (green_values[index_valid] - swir_values[index_valid]) / mndwi_denominator[index_valid]
    ndwi_water = index_valid & (ndwi > 0)
    mndwi_water = index_valid & (mndwi > 0)
    return {
        "valid_pixels": int(valid.sum()),
        "clear_pixels": int(index_valid.sum()),
        "ndwi_sum": float(ndwi[index_valid].sum()),
        "mndwi_sum": float(mndwi[index_valid].sum()),
        "ndwi_water_pixels": int(ndwi_water.sum()),
        "mndwi_water_pixels": int(mndwi_water.sum()),
        "ndwi_water_area_km2": float(ndwi_water.sum() * pixel_area_km2),
        "mndwi_water_area_km2": float(mndwi_water.sum() * pixel_area_km2),
    }


def _payload(product: ImageryProduct, metric: ProductWaterMetric, cache_status: str | None = None) -> dict[str, Any]:
    result = {
        "product_record_id": product.id,
        "product_id": product.product_id,
        "reservoir_id": product.reservoir_id,
        "acquired_at": product.acquired_at.isoformat() + "Z",
        "platform": product.platform,
        "computed_at": metric.computed_at.isoformat() + "Z",
        "method": metric.method,
        "valid_pixels": metric.valid_pixels,
        "clear_pixels": metric.clear_pixels,
        "ndwi_mean": metric.ndwi_mean,
        "mndwi_mean": metric.mndwi_mean,
        "ndwi_water_area_km2": metric.ndwi_water_area_km2,
        "mndwi_water_area_km2": metric.mndwi_water_area_km2,
        "estimated_water_area_km2": metric.estimated_water_area_km2,
        "reservoir_reference_area_km2": metric.reservoir_reference_area_km2,
        "clear_observation_ratio": metric.clear_observation_ratio,
        "area_change_from_reference_pct": metric.area_change_from_reference_pct,
        "method_disagreement_pct": metric.method_disagreement_pct,
        "confidence": metric.confidence,
        "status": metric.status,
    }
    if cache_status:
        result["cache_status"] = cache_status
    return result


def compute_product_water(product_record_id: str, force: bool = False) -> dict[str, Any]:
    with SessionLocal() as db:
        product = db.get(ImageryProduct, product_record_id)
        if product is None:
            raise ValueError(f"未找到产品：{product_record_id}")
        if product.source != "copernicus-cdse":
            raise ValueError("当前水体指数仅支持Sentinel-2 L2A")
        existing = db.get(ProductWaterMetric, product.id)
        if existing is not None and not force:
            return _payload(product, existing, "hit")
        reservoir = get_reservoir(product.reservoir_id)
        if reservoir is None:
            raise ValueError(f"未找到水库：{product.reservoir_id}")

        raw = json.loads(product.raw_item)
        components = raw.get("components", []) if isinstance(raw, dict) else []
        reservoir_geometry = shape(reservoir["geometry"])
        covered = GeometryCollection()
        totals: dict[str, float] = {
            "valid_pixels": 0, "clear_pixels": 0, "ndwi_sum": 0, "mndwi_sum": 0,
            "ndwi_water_pixels": 0, "mndwi_water_pixels": 0,
            "ndwi_water_area_km2": 0, "mndwi_water_area_km2": 0,
        }
        sources = []
        with httpx.Client(timeout=httpx.Timeout(40.0), follow_redirects=True) as client:
            for component in components:
                item_id = earth_search_id(str(component.get("id", "")))
                if item_id is None or not component.get("geometry"):
                    continue
                footprint_part = reservoir_geometry.intersection(shape(component["geometry"]))
                unique_part = footprint_part.difference(covered)
                covered = covered.union(footprint_part)
                if unique_part.is_empty:
                    continue
                response = client.get(EARTH_SEARCH_ITEM.format(item_id=item_id))
                response.raise_for_status()
                item = response.json()
                values = _component_metrics(item.get("assets", {}), mapping(unique_part))
                for key in totals:
                    totals[key] += float(values[key])
                sources.append({"earth_search_item": item_id, "geometry_area_degrees": unique_part.area})

        clear_pixels = int(totals["clear_pixels"])
        valid_pixels = int(totals["valid_pixels"])
        if clear_pixels == 0 or valid_pixels == 0:
            raise ValueError("水库范围内没有无云有效像元")
        reference_area = float(reservoir["properties"]["area_km2"])
        ndwi_area = round(reference_area * totals["ndwi_water_pixels"] / clear_pixels, 4)
        mndwi_area = round(reference_area * totals["mndwi_water_pixels"] / clear_pixels, 4)
        clear_ratio = round(clear_pixels / valid_pixels * 100, 2)
        disagreement = round(abs(ndwi_area - mndwi_area) / max(mndwi_area, 0.0001) * 100, 2)
        change = round((mndwi_area - reference_area) / reference_area * 100, 2)
        confidence = "高" if clear_ratio >= 85 and disagreement <= 15 else "中" if clear_ratio >= 60 and disagreement <= 35 else "低"
        values = {
            "computed_at": utc_now(),
            "method": METHOD,
            "valid_pixels": valid_pixels,
            "clear_pixels": clear_pixels,
            "ndwi_mean": round(totals["ndwi_sum"] / clear_pixels, 4),
            "mndwi_mean": round(totals["mndwi_sum"] / clear_pixels, 4),
            "ndwi_water_pixels": int(totals["ndwi_water_pixels"]),
            "mndwi_water_pixels": int(totals["mndwi_water_pixels"]),
            "ndwi_water_area_km2": ndwi_area,
            "mndwi_water_area_km2": mndwi_area,
            "estimated_water_area_km2": mndwi_area,
            "reservoir_reference_area_km2": reference_area,
            "clear_observation_ratio": clear_ratio,
            "area_change_from_reference_pct": change,
            "method_disagreement_pct": disagreement,
            "confidence": confidence,
            "status": "completed",
            "detail": json.dumps({
                "sources": sources,
                "primary_estimate": "MNDWI > 0",
                "area_normalization": "water fraction among clear pixels multiplied by SHP reference extent",
                "observed_clear_ndwi_water_area_km2": round(totals["ndwi_water_area_km2"], 4),
                "observed_clear_mndwi_water_area_km2": round(totals["mndwi_water_area_km2"], 4),
            }, ensure_ascii=False),
        }
        metric = db.get(ProductWaterMetric, product.id)
        if metric is None:
            metric = ProductWaterMetric(product_record_id=product.id, **values)
            db.add(metric)
        else:
            for key, value in values.items():
                setattr(metric, key, value)
        db.commit()
        db.refresh(metric)
        return _payload(product, metric, "refreshed")


def water_series(reservoir_id: str) -> dict[str, Any]:
    with SessionLocal() as db:
        rows = db.execute(
            select(ImageryProduct, ProductWaterMetric)
            .join(ProductWaterMetric, ProductWaterMetric.product_record_id == ImageryProduct.id)
            .where(ImageryProduct.reservoir_id == reservoir_id)
            .order_by(ImageryProduct.acquired_at.asc())
        ).all()
        items = [_payload(product, metric) for product, metric in rows]
    return {"reservoir_id": reservoir_id, "count": len(items), "method": METHOD, "items": items}


def compute_reservoir_water(reservoir_id: str, limit: int = 3, force: bool = False) -> dict[str, Any]:
    with SessionLocal() as db:
        ids = db.scalars(
            select(ImageryProduct.id)
            .where(ImageryProduct.reservoir_id == reservoir_id, ImageryProduct.source == "copernicus-cdse")
            .order_by(ImageryProduct.acquired_at.desc())
            .limit(limit)
        ).all()
    results, failures = [], []
    for product_id in ids:
        try:
            results.append(compute_product_water(product_id, force))
        except Exception as exc:
            failures.append({"product_record_id": product_id, "error": str(exc)})
    return {
        "reservoir_id": reservoir_id,
        "requested": len(ids),
        "completed": len(results),
        "failures": failures,
        "series": water_series(reservoir_id)["items"],
    }
