from __future__ import annotations

import copy
import json
from functools import lru_cache
from typing import Any

from .config import PUBLIC_DATA_DIR


@lru_cache(maxsize=1)
def reservoir_collection() -> dict[str, Any]:
    path = PUBLIC_DATA_DIR / "reservoirs.geojson"
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if len(payload.get("features", [])) != 25:
        raise RuntimeError("Reservoir GeoJSON must contain exactly 25 features")
    return payload


@lru_cache(maxsize=1)
def reservoir_index() -> dict[str, dict[str, Any]]:
    index: dict[str, dict[str, Any]] = {}
    for feature in reservoir_collection()["features"]:
        props = feature["properties"]
        for key in (props["id"], props["code"], props["name_cn"], str(props.get("osm_id", ""))):
            if key:
                index[key] = feature
    return index


def list_reservoirs(include_geometry: bool = True) -> dict[str, Any]:
    payload = copy.deepcopy(reservoir_collection())
    if not include_geometry:
        for feature in payload["features"]:
            feature["geometry"] = None
    return payload


def get_reservoir(reservoir_id: str) -> dict[str, Any] | None:
    item = reservoir_index().get(reservoir_id)
    return copy.deepcopy(item) if item else None
