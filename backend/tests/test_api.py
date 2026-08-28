from __future__ import annotations

from fastapi.testclient import TestClient

from backend.app.main import app
from backend.app.config import ADMIN_API_KEY
from backend.app.services.imagery import _coverage_ratio
from backend.app.services.quality import earth_search_id
from backend.app.services.water import _scale_offset


client = TestClient(app)
ADMIN_HEADERS = {"X-Admin-Key": ADMIN_API_KEY}


def test_health() -> None:
    with client:
        response = client.get("/api/v1/health")
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["reservoir_count"] == 25


def test_scheduler_status() -> None:
    with client:
        response = client.get("/api/v1/scheduler/status")
    assert response.status_code == 200
    payload = response.json()
    assert payload["enabled"] is True
    assert payload["running"] is True
    assert {job["id"] for job in payload["jobs"]} == {"refresh-orbits", "refresh-all-imagery", "backup-database"}


def test_public_read_endpoints_do_not_require_admin_key() -> None:
    with client:
        health = client.get("/api/v1/health")
        products = client.get("/api/v1/reservoirs/HN_RSV_024/products")
    assert health.status_code == 200
    assert products.status_code == 200


def test_admin_endpoints_reject_missing_or_invalid_key() -> None:
    with client:
        missing = client.get("/api/v1/admin/overview")
        invalid = client.get("/api/v1/admin/overview", headers={"X-Admin-Key": "invalid"})
        protected_requests = [
            client.get("/api/v1/admin/tasks"),
            client.get("/api/v1/imagery/status"),
            client.post("/api/v1/admin/backup"),
            client.post("/api/v1/orbits/refresh?days=30"),
            client.post("/api/v1/imagery/refresh-all?days=90"),
            client.post("/api/v1/reservoirs/HN_RSV_024/products/refresh?days=30"),
            client.post("/api/v1/reservoirs/HN_RSV_024/quality/refresh?limit=1"),
            client.post("/api/v1/reservoirs/HN_RSV_024/water/refresh?limit=1"),
        ]
    assert missing.status_code == 401
    assert invalid.status_code == 401
    assert all(response.status_code == 401 for response in protected_requests)
    assert missing.headers["www-authenticate"] == "ApiKey"


def test_reservoir_collection_and_detail() -> None:
    with client:
        response = client.get("/api/v1/reservoirs")
        detail = client.get("/api/v1/reservoirs/HN_RSV_001")
    assert response.status_code == 200
    assert len(response.json()["features"]) == 25
    assert detail.status_code == 200
    assert detail.json()["properties"]["name_cn"] == "彰武水库"


def test_missing_reservoir() -> None:
    with client:
        response = client.get("/api/v1/reservoirs/not-found")
    assert response.status_code == 404


def test_passes_are_explicit_about_data_mode() -> None:
    with client:
        response = client.get("/api/v1/reservoirs/HN_RSV_024/passes?days=30")
    payload = response.json()
    assert response.status_code == 200
    assert payload["items"]
    if payload["data_mode"] == "orbit_prediction":
        assert payload["operational"] is True
        assert all(item["source_type"] == "orbit_prediction" for item in payload["items"])
        assert all(item["is_imaging_confirmed"] is False for item in payload["items"])
        assert all(item["coverage"] == 100.0 for item in payload["items"])
        assert all(item["coverage_method"] == "ground-track-swath/polygon-intersection-v2" for item in payload["items"])
    else:
        assert payload["operational"] is False
        assert all(item["source_type"] == "demonstration_prediction" for item in payload["items"])


def test_calendar_limit() -> None:
    with client:
        response = client.get("/api/v1/calendar?days=7&limit=10")
    payload = response.json()
    assert response.status_code == 200
    assert len(payload["items"]) == 10


def test_satellite_catalog_is_explicit_about_prediction_readiness() -> None:
    with client:
        response = client.get("/api/v1/satellites")
    assert response.status_code == 200
    items = response.json()["items"]
    assert len(items) == 7
    landsat_9 = next(item for item in items if item["id"] == "landsat-9")
    assert landsat_9["norad_cat_id"] == 49260
    assert landsat_9["swath_km"] == 185.0
    hj_2b = next(item for item in items if item["id"] == "hj-2b")
    assert hj_2b["prediction_enabled"] is True
    assert hj_2b["swath_km"] == 800.0
    assert hj_2b["actual_products_integrated"] is False
    gaofen_1 = next(item for item in items if item["id"] == "gaofen-1")
    assert gaofen_1["prediction_enabled"] is True
    assert gaofen_1["swath_km"] == 800.0


def test_domestic_satellite_status_is_explicit_about_catalog_limits() -> None:
    with client:
        response = client.get("/api/v1/domestic-satellites")
    assert response.status_code == 200
    payload = response.json()
    assert len(payload["items"]) == 2
    assert payload["is_imaging_confirmed"] is False
    assert all(item["prediction_enabled"] for item in payload["items"])
    assert all(item["actual_products_integrated"] is False for item in payload["items"])
    assert all(item["product_catalog_url"].startswith("https://") for item in payload["items"])


def test_domestic_passes_are_geometric_predictions_not_confirmed_imaging() -> None:
    with client:
        response = client.get("/api/v1/reservoirs/HN_RSV_024/passes?days=30")
    domestic = [item for item in response.json()["items"] if item["satellite"] in {"HJ-2B", "Gaofen-1"}]
    assert domestic
    assert all(item["source_type"] == "orbit_prediction" for item in domestic)
    assert all(item["is_imaging_confirmed"] is False for item in domestic)
    assert all(item["coverage"] == 100.0 for item in domestic)


def test_orbit_status_before_or_after_refresh() -> None:
    with client:
        response = client.get("/api/v1/orbits/status")
    assert response.status_code == 200
    assert len(response.json()["satellites"]) == 7


def test_product_catalog_endpoint_has_explicit_cloud_scope() -> None:
    with client:
        response = client.get("/api/v1/reservoirs/HN_RSV_024/products")
    assert response.status_code == 200
    payload = response.json()
    assert payload["cache_status"] in {"missing", "stale", "fresh"}
    assert payload["cloud_metric_scope"].startswith("product-footprint")
    assert all(item["coverage_ratio"] >= 99.9 for item in payload["items"])


def test_product_coverage_uses_geometry_intersection() -> None:
    reservoir = {"type": "Polygon", "coordinates": [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]]}
    footprint = {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 2], [0, 2], [0, 0]]]}
    ratio = _coverage_ratio(reservoir, footprint, 1, 1)
    assert 49 < ratio < 51


def test_imagery_batch_status_and_products_are_view_only() -> None:
    with client:
        status = client.get("/api/v1/imagery/status", headers=ADMIN_HEADERS)
        products = client.get("/api/v1/reservoirs/HN_RSV_024/products").json()["items"]
    assert status.status_code == 200
    assert status.json()["reservoirs_with_products"] >= 1
    assert products
    assert all("preview_url" in item and "catalog_url" in item for item in products)
    assert all("download_url" not in item and "manifest_url" not in item for item in products)


def test_sentinel_product_id_maps_to_public_scl_item() -> None:
    product_id = "S2B_MSIL2A_20260827T031529_N0512_R075_T49SES_20260827T065641"
    assert earth_search_id(product_id) == "S2B_49SES_20260827_0_L2A"


def test_local_cloud_metric_is_exposed_when_computed() -> None:
    with client:
        response = client.get("/api/v1/reservoirs/HN_RSV_024/products")
    metrics = [item for item in response.json()["items"] if item["local_cloud_cover"] is not None]
    assert metrics
    assert all(0 <= item["local_cloud_cover"] <= 100 for item in metrics)
    assert all(item["observation_quality_level"] in {"优质", "可用", "多云"} for item in metrics)


def test_sentinel_reflectance_scale_and_offset_are_read() -> None:
    asset = {"raster:bands": [{"scale": 0.0001, "offset": -0.1}]}
    assert _scale_offset(asset) == (0.0001, -0.1)


def test_water_series_endpoint_exposes_method_and_quality() -> None:
    with client:
        response = client.get("/api/v1/reservoirs/HN_RSV_001/water-series")
    assert response.status_code == 200
    payload = response.json()
    assert "NDWI/MNDWI" in payload["method"]
    for item in payload["items"]:
        assert -1 <= item["ndwi_mean"] <= 1
        assert -1 <= item["mndwi_mean"] <= 1
        assert item["estimated_water_area_km2"] >= 0
        assert 0 <= item["clear_observation_ratio"] <= 100
        assert item["confidence"] in {"高", "中", "低"}


def test_admin_overview_reports_storage_scheduler_and_counts() -> None:
    with client:
        response = client.get("/api/v1/admin/overview", headers=ADMIN_HEADERS)
    assert response.status_code == 200
    payload = response.json()
    assert payload["counts"]["reservoirs"] == 25
    assert payload["counts"]["imagery_products"] >= 1
    assert payload["storage"]["database_bytes"] > 0
    assert "preview_cache" in payload["storage"]
    assert "database_backups" in payload["storage"]
    assert "problem_tasks" in payload
    assert {job["id"] for job in payload["scheduler"]["jobs"]} == {"refresh-orbits", "refresh-all-imagery", "backup-database"}


def test_admin_tasks_are_newest_first() -> None:
    with client:
        response = client.get("/api/v1/admin/tasks?limit=5", headers=ADMIN_HEADERS)
    assert response.status_code == 200
    items = response.json()["items"]
    assert len(items) <= 5
    assert [item["started_at"] for item in items] == sorted(
        [item["started_at"] for item in items], reverse=True
    )
