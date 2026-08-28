from __future__ import annotations

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo


SATELLITES = [
    {"satellite": "Sentinel-2A", "cycle": 5, "start_add": 0, "coverage": 96},
    {"satellite": "Landsat-9", "cycle": 8, "start_add": 2, "coverage": 91},
    {"satellite": "HJ-2B", "cycle": 4, "start_add": 1, "coverage": 82},
    {"satellite": "GF-1", "cycle": 6, "start_add": 3, "coverage": 78},
]


def generate_passes(reservoir: dict, days: int = 30, start_date: date | None = None) -> list[dict]:
    props = reservoir["properties"]
    seed = int(props["code"][-3:])
    start_date = start_date or datetime.now(ZoneInfo("Asia/Shanghai")).date()
    results = []

    for group_index, definition in enumerate(SATELLITES):
        first_offset = max(1, (seed + definition["start_add"]) % definition["cycle"])
        for offset in range(first_offset, days + 1, definition["cycle"]):
            pass_date = start_date + timedelta(days=offset)
            hour = 9 + ((seed + offset + group_index) % 4)
            minute = (seed * 7 + offset * 3) % 60
            results.append(
                {
                    "id": f"{props['id']}-{definition['satellite']}-{pass_date.isoformat()}",
                    "reservoir_id": props["id"],
                    "date": pass_date.isoformat(),
                    "time": f"{hour:02d}:{minute:02d}",
                    "satellite": definition["satellite"],
                    "confidence": "B",
                    "source_type": "demonstration_prediction",
                    "sourceLabel": "演示预测",
                    "coverage": max(55, definition["coverage"] - ((seed + offset) % 13)),
                    "is_operational": False,
                    "warning": "界面与接口联调用演示预测，不能用于实验安排。",
                }
            )
    return sorted(results, key=lambda item: (item["date"], item["time"], item["satellite"]))
