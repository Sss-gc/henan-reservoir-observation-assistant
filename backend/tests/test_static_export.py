from __future__ import annotations

from datetime import datetime, timedelta, timezone
from contextlib import nullcontext

import pytest

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from backend.app.database import Base
from backend.app.models import Satellite, SatellitePassRecord
from backend.app.tasks import export_static_observations
from backend.app.tasks.export_static_observations import build_static_payload


def test_static_export_contains_only_future_operational_passes() -> None:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    with Session(engine) as db:
        db.add(
            Satellite(
                id="test-satellite",
                name="TestSat",
                norad_cat_id=1,
                intl_designator="2026-001A",
                sensor="TEST",
                swath_km=100,
                prediction_enabled=True,
                catalog_status="test",
                source_url="https://example.com",
            )
        )
        db.add(
            SatellitePassRecord(
                id="future-pass",
                reservoir_id="HN_RSV_001",
                satellite_id="test-satellite",
                start_time_utc=now + timedelta(hours=1),
                center_time_utc=now + timedelta(hours=2),
                end_time_utc=now + timedelta(hours=3),
                min_distance_km=1,
                coverage_ratio=100,
                element_epoch=now,
                created_at=now,
                confidence="B",
                coverage_method="ground-track-swath/polygon-intersection-v2",
                solar_elevation_deg=52.1,
                solar_azimuth_deg=145.2,
                satellite_elevation_deg=76.4,
                satellite_azimuth_deg=342.8,
                glint_angle_deg=48.3,
                glint_risk="minimal",
            )
        )
        db.commit()
        payload = build_static_payload(db, 30)
    assert payload["item_count"] == 1
    assert payload["items"][0]["coverage"] == 100
    assert payload["items"][0]["is_imaging_confirmed"] is False
    assert payload["items"][0]["glint_angle_deg"] == 48.3
    assert payload["items"][0]["glint_risk"] == "minimal"
    assert payload["schema_version"] == "static-observation-v2"
    assert payload["is_imaging_confirmed"] is False


def test_empty_refresh_keeps_the_previous_file(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    output = tmp_path / "orbit-passes.json"
    output.write_text("previous valid data", encoding="utf-8")
    monkeypatch.setattr(export_static_observations, "SessionLocal", lambda: nullcontext(None))
    monkeypatch.setattr(export_static_observations, "build_static_payload", lambda _db, _days: {"items": []})

    with pytest.raises(RuntimeError, match="没有生成任何卫星观测窗口"):
        export_static_observations.write_static_payload(output)

    assert output.read_text(encoding="utf-8") == "previous valid data"
