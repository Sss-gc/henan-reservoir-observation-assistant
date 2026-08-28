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
    items = passes.get("items", [])
    assert items, "orbit-passes.json不能为空"
    assert passes["is_imaging_confirmed"] is False
    assert passes["reservoirs_with_passes"] == len({item["reservoir_id"] for item in items})
    for item in items:
        assert item["reservoir_id"] in reservoir_ids
        assert item["coverage"] >= 99.9
        assert item["is_imaging_confirmed"] is False
        datetime.fromisoformat(item["time_utc"].replace("Z", "+00:00"))
        assert len(item["time"]) == 5
    print(
        f"静态观测数据验证通过：{len(features)}座水库，"
        f"{len(items)}条完整覆盖窗口，覆盖{passes['reservoirs_with_passes']}座水库。"
    )


if __name__ == "__main__":
    main()
