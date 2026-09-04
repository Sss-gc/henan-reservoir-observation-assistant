from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    reservoirs = json.loads((ROOT / "public/data/reservoirs.geojson").read_text(encoding="utf-8"))
    passes = json.loads((ROOT / "public/data/orbit-passes.json").read_text(encoding="utf-8"))
    features = reservoirs.get("features", [])
    assert len(features) == 25, "reservoirs.geojson必须包含25座水库"
    reservoir_ids = {item["properties"]["id"] for item in features}
    danjiang = next(item for item in features if item["properties"]["id"] == "HN_RSV_024")
    assert danjiang["geometry"]["type"] == "MultiPolygon"
    assert len(danjiang["geometry"]["coordinates"]) >= 3, "丹江口水库必须包含主库区和汉江补充区域"
    assert danjiang["properties"]["area_km2"] > 810
    assert "汉江.shp" in danjiang["properties"]["data_source"]
    assert danjiang["properties"]["geometry_status"] == "verified-valid-supplemented"
    danjiang_min_lat = min(
        coordinate[1]
        for polygon in danjiang["geometry"]["coordinates"]
        for ring in polygon
        for coordinate in ring
    )
    assert danjiang_min_lat < 32.39, "丹江口水库南侧汉江区域未纳入静态边界"
    items = passes.get("items", [])
    assert items, "orbit-passes.json不能为空"
    assert passes["is_imaging_confirmed"] is False
    assert passes["schema_version"] == "static-observation-v2"
    assert passes["reservoirs_with_passes"] == len({item["reservoir_id"] for item in items})
    for item in items:
        if item['satellite'].startswith('HJ'):
            assert item['satellite'] == 'HJ-2B', 'HJ仅保留HJ-2B'
            assert item['sensor'] == 'CCD1–CCD4 (16 m，四相机拼接)', 'HJ-2B必须使用CCD系列'
        assert item["reservoir_id"] in reservoir_ids
        assert item["coverage"] >= 99.9
        assert item["is_imaging_confirmed"] is False
        assert 0 <= item["solar_elevation_deg"] <= 90
        assert 0 <= item["solar_azimuth_deg"] < 360
        assert -90 <= item["satellite_elevation_deg"] <= 90
        assert 0 <= item["satellite_azimuth_deg"] < 360
        assert 0 <= item["glint_angle_deg"] <= 180
        assert item["glint_risk"] in {"high", "medium", "low", "minimal"}
        datetime.fromisoformat(item["time_utc"].replace("Z", "+00:00"))
        assert len(item["time"]) == 5
    print(
        f"静态观测数据验证通过：{len(features)}座水库，"
        f"{len(items)}条完整覆盖窗口，覆盖{passes['reservoirs_with_passes']}座水库。"
    )


if __name__ == "__main__":
    main()
