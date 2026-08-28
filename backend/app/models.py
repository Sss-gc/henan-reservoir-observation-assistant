from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


class WeatherCache(Base):
    __tablename__ = "weather_cache"

    reservoir_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    fetched_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    payload: Mapped[str] = mapped_column(Text, nullable=False)


class TaskRun(Base):
    __tablename__ = "task_runs"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    task_name: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    started_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    status: Mapped[str] = mapped_column(String(24), nullable=False)
    detail: Mapped[str] = mapped_column(Text, default="")


class Satellite(Base):
    __tablename__ = "satellites"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    norad_cat_id: Mapped[int] = mapped_column(Integer, nullable=False, unique=True, index=True)
    intl_designator: Mapped[str] = mapped_column(String(16), nullable=False)
    sensor: Mapped[str] = mapped_column(String(64), nullable=False)
    swath_km: Mapped[float | None] = mapped_column(Float, nullable=True)
    prediction_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    catalog_status: Mapped[str] = mapped_column(String(32), nullable=False, default="registered")
    source_url: Mapped[str] = mapped_column(Text, nullable=False)


class OrbitalElement(Base):
    __tablename__ = "orbital_elements"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    satellite_id: Mapped[str] = mapped_column(ForeignKey("satellites.id"), nullable=False, index=True)
    epoch: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    fetched_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    source_format: Mapped[str] = mapped_column(String(24), nullable=False, default="OMM_JSON")
    source_url: Mapped[str] = mapped_column(Text, nullable=False)
    payload: Mapped[str] = mapped_column(Text, nullable=False)


class SatellitePassRecord(Base):
    __tablename__ = "satellite_passes"

    id: Mapped[str] = mapped_column(String(160), primary_key=True)
    reservoir_id: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    satellite_id: Mapped[str] = mapped_column(ForeignKey("satellites.id"), nullable=False, index=True)
    start_time_utc: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    center_time_utc: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    end_time_utc: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    min_distance_km: Mapped[float] = mapped_column(Float, nullable=False)
    coverage_ratio: Mapped[float] = mapped_column(Float, nullable=False)
    element_epoch: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    confidence: Mapped[str] = mapped_column(String(8), nullable=False, default="B")
    coverage_method: Mapped[str] = mapped_column(String(64), nullable=False)


class ImageryProduct(Base):
    __tablename__ = "imagery_products"

    id: Mapped[str] = mapped_column(String(320), primary_key=True)
    reservoir_id: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    product_id: Mapped[str] = mapped_column(String(220), nullable=False, index=True)
    source: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    collection: Mapped[str] = mapped_column(String(64), nullable=False)
    platform: Mapped[str] = mapped_column(String(64), nullable=False)
    acquired_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    cloud_cover: Mapped[float | None] = mapped_column(Float, nullable=True)
    coverage_ratio: Mapped[float] = mapped_column(Float, nullable=False)
    resolution_m: Mapped[float] = mapped_column(Float, nullable=False)
    thumbnail_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    catalog_url: Mapped[str] = mapped_column(Text, nullable=False)
    download_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    download_requires_auth: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    fetched_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    raw_item: Mapped[str] = mapped_column(Text, nullable=False)


class ProductQualityMetric(Base):
    __tablename__ = "product_quality_metrics"

    product_record_id: Mapped[str] = mapped_column(
        ForeignKey("imagery_products.id"), primary_key=True
    )
    computed_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    metric_source: Mapped[str] = mapped_column(String(64), nullable=False)
    valid_pixels: Mapped[int] = mapped_column(Integer, nullable=False)
    cloud_pixels: Mapped[int] = mapped_column(Integer, nullable=False)
    shadow_pixels: Mapped[int] = mapped_column(Integer, nullable=False)
    snow_pixels: Mapped[int] = mapped_column(Integer, nullable=False)
    local_cloud_cover: Mapped[float] = mapped_column(Float, nullable=False)
    local_obscured_ratio: Mapped[float] = mapped_column(Float, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="completed")
    detail: Mapped[str] = mapped_column(Text, nullable=False, default="")


class ProductWaterMetric(Base):
    __tablename__ = "product_water_metrics"

    product_record_id: Mapped[str] = mapped_column(
        ForeignKey("imagery_products.id"), primary_key=True
    )
    computed_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    method: Mapped[str] = mapped_column(String(160), nullable=False)
    valid_pixels: Mapped[int] = mapped_column(Integer, nullable=False)
    clear_pixels: Mapped[int] = mapped_column(Integer, nullable=False)
    ndwi_mean: Mapped[float] = mapped_column(Float, nullable=False)
    mndwi_mean: Mapped[float] = mapped_column(Float, nullable=False)
    ndwi_water_pixels: Mapped[int] = mapped_column(Integer, nullable=False)
    mndwi_water_pixels: Mapped[int] = mapped_column(Integer, nullable=False)
    ndwi_water_area_km2: Mapped[float] = mapped_column(Float, nullable=False)
    mndwi_water_area_km2: Mapped[float] = mapped_column(Float, nullable=False)
    estimated_water_area_km2: Mapped[float] = mapped_column(Float, nullable=False)
    reservoir_reference_area_km2: Mapped[float] = mapped_column(Float, nullable=False)
    clear_observation_ratio: Mapped[float] = mapped_column(Float, nullable=False)
    area_change_from_reference_pct: Mapped[float] = mapped_column(Float, nullable=False)
    method_disagreement_pct: Mapped[float] = mapped_column(Float, nullable=False)
    confidence: Mapped[str] = mapped_column(String(16), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="completed")
    detail: Mapped[str] = mapped_column(Text, nullable=False, default="")
