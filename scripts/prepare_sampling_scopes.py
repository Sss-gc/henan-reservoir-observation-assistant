from __future__ import annotations

import json
from pathlib import Path

from pyproj import CRS, Geod, Transformer
from shapely import make_valid
from shapely.geometry import GeometryCollection, LineString, MultiLineString, MultiPolygon, Polygon, mapping, shape
from shapely.ops import nearest_points, transform, unary_union


ROOT = Path(__file__).resolve().parents[1]
RESERVOIRS_PATH = ROOT / "public" / "data" / "reservoirs.geojson"
HENAN_BOUNDARY_PATH = ROOT / "public" / "data" / "henan-boundary.geojson"
OUTPUT_PATH = ROOT / "public" / "data" / "reservoir-sampling-scopes.geojson"
GEOD = Geod(ellps="WGS84")


def polygonal_only(geometry):
    geometry = make_valid(geometry)
    if isinstance(geometry, (Polygon, MultiPolygon)):
        return geometry
    if isinstance(geometry, GeometryCollection):
        pieces = [part for part in geometry.geoms if isinstance(part, (Polygon, MultiPolygon))]
        return unary_union(pieces)
    return Polygon()


def polygons(geometry):
    if isinstance(geometry, Polygon):
        return [geometry]
    if isinstance(geometry, MultiPolygon):
        return list(geometry.geoms)
    return []


def lines(geometry):
    if isinstance(geometry, LineString):
        return [geometry]
    if isinstance(geometry, MultiLineString):
        return list(geometry.geoms)
    if isinstance(geometry, GeometryCollection):
        return [part for item in geometry.geoms for part in lines(item)]
    return []


def geodesic_area_km2(geometry):
    area_m2, _ = GEOD.geometry_area_perimeter(geometry)
    return abs(area_m2) / 1_000_000


def local_transformers(geometry):
    center = geometry.representative_point()
    local_crs = CRS.from_proj4(
        f"+proj=aeqd +lat_0={center.y} +lon_0={center.x} +datum=WGS84 +units=m +no_defs"
    )
    forward = Transformer.from_crs("EPSG:4326", local_crs, always_xy=True).transform
    reverse = Transformer.from_crs(local_crs, "EPSG:4326", always_xy=True).transform
    return forward, reverse


def shoreline_candidates(full_geometry, clipped_geometry, province_geometry):
    forward, reverse = local_transformers(clipped_geometry)
    clipped_local = transform(forward, clipped_geometry)
    province_local = transform(forward, province_geometry)
    outer_shore = unary_union([LineString(part.exterior.coords) for part in polygons(full_geometry)])
    actual_henan_shore = transform(forward, outer_shore).intersection(province_local)
    shore_lines = [line for line in lines(actual_henan_shore) if line.length >= 20]
    total_length = sum(line.length for line in shore_lines)
    spacing = min(250.0, max(80.0, total_length / 1600.0))

    inner = clipped_local.buffer(-75)
    if inner.is_empty:
        inner = clipped_local.buffer(-40)
    if inner.is_empty:
        inner = clipped_local.buffer(-20)
    if inner.is_empty:
        return []

    candidates = []
    used = set()
    for line in shore_lines:
        distance = spacing / 2
        while distance < line.length:
            shore_point = line.interpolate(distance)
            water_point = nearest_points(shore_point, inner)[1]
            offset = shore_point.distance(water_point)
            key = (round(water_point.x / 25), round(water_point.y / 25))
            if 15 <= offset <= 180 and key not in used and clipped_local.covers(water_point):
                wgs84 = transform(reverse, water_point)
                candidates.append([round(wgs84.x, 6), round(wgs84.y, 6)])
                used.add(key)
            distance += spacing
    return candidates


def main():
    reservoirs = json.loads(RESERVOIRS_PATH.read_text(encoding="utf-8"))
    boundary = json.loads(HENAN_BOUNDARY_PATH.read_text(encoding="utf-8"))
    province_geometry = unary_union([shape(feature["geometry"]) for feature in boundary["features"]])
    features = []

    for source in reservoirs["features"]:
        properties = source["properties"]
        full_geometry = polygonal_only(shape(source["geometry"]))
        clipped_geometry = polygonal_only(full_geometry.intersection(province_geometry))
        if clipped_geometry.is_empty:
            raise RuntimeError(f"{properties['id']} 与河南省界相交结果为空")

        full_geodesic_area = geodesic_area_km2(full_geometry)
        clipped_geodesic_area = geodesic_area_km2(clipped_geometry)
        retained_ratio = clipped_geodesic_area / full_geodesic_area
        published_area = float(properties["area_km2"])
        sampling_area = published_area if retained_ratio >= 0.9995 else published_area * retained_ratio
        center = clipped_geometry.representative_point()
        candidates = shoreline_candidates(full_geometry, clipped_geometry, province_geometry)
        if len(candidates) < 10:
            raise RuntimeError(f"{properties['id']} 岸边候选点不足10个：{len(candidates)}")

        features.append(
            {
                "type": "Feature",
                "properties": {
                    "id": properties["id"],
                    "scope": "河南省境内库区",
                    "sampling_area_km2": round(sampling_area, 2),
                    "full_area_km2": published_area,
                    "retained_pct": round(retained_ratio * 100, 2),
                    "lon": round(center.x, 6),
                    "lat": round(center.y, 6),
                    "shore_candidates": candidates,
                    "shore_candidate_note": "沿河南省境内真实外岸线向水体内侧约75米生成；道路、坡岸和管制条件须现场复核",
                },
                "geometry": mapping(clipped_geometry),
            }
        )

    payload = {"type": "FeatureCollection", "features": features}
    OUTPUT_PATH.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    cross_province = [
        feature for feature in features if feature["properties"]["retained_pct"] < 99.95
    ]
    print(f"已生成{len(features)}座水库的河南库区采样范围；跨省裁剪{len(cross_province)}座。")
    for feature in cross_province:
        item = feature["properties"]
        print(
            f"{item['id']}: {item['full_area_km2']:.2f} -> {item['sampling_area_km2']:.2f} km2 "
            f"({item['retained_pct']:.2f}%)，岸边候选{len(item['shore_candidates'])}个"
        )


if __name__ == "__main__":
    main()
