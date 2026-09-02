from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import shapefile
from pyproj import Geod
from shapely import make_valid
from shapely.geometry import GeometryCollection, MultiPolygon, Polygon, mapping, shape
from shapely.ops import unary_union


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = Path(
    os.environ.get(
        "RESERVOIR_GIS_ROOT",
        r"F:\AAAAPostgraduate\AAAGIS\地图资源",
    )
)
RESERVOIR_SHP = SOURCE_ROOT / "河南省25个省控水库" / "25个省控水库.shp"
CITY_SHP = SOURCE_ROOT / "中国审图号：GS（2024）0650号" / "河南省各地市.shp"
PROVINCE_SHP = SOURCE_ROOT / "2024河流湖泊" / "河南省水域线" / "河南省界.shp"
DANJIANG_HANJIANG_SHP = SOURCE_ROOT / "2024河流湖泊" / "丹江口水库" / "汉江.shp"
OUTPUT_DIR = PROJECT_ROOT / "public" / "data"
VALIDATION_DIR = PROJECT_ROOT / "data" / "source_validation"
GEOD = Geod(ellps="WGS84")

OFFICIAL_CITY_BY_NAME = {
    "彰武水库": "安阳市",
    "陆浑水库": "洛阳市",
    "昭平台水库": "平顶山市",
    "石山口水库": "信阳市",
    "板桥水库": "驻马店市",
    "宋家场水库": "驻马店市",
    "盘石头水库": "鹤壁市",
    "孤石滩水库": "平顶山市",
    "石漫滩水库": "平顶山市",
    "故县水库": "洛阳市",
    "窄口水库": "三门峡市",
    "鸭河口水库": "南阳市",
    "五岳水库": "信阳市",
    "白龟山水库": "平顶山市",
    "尖岗水库": "郑州市",
    "小浪底水库": "济源市",
    "三门峡水库": "三门峡市",
    "宿鸭湖水库": "驻马店市",
    "泼河水库": "信阳市",
    "鲇鱼山水库": "信阳市",
    "南湾水库": "信阳市",
    "出山店水库": "信阳市",
    "薄山水库": "驻马店市",
    "丹江口水库": "南阳市",
    "白沙水库": "许昌市",
}

CROSS_CITY_DISPLAY = {
    "盘石头水库": "鹤壁市（跨安阳市）",
    "孤石滩水库": "平顶山市（跨南阳市）",
    "故县水库": "洛阳市（跨三门峡市）",
    "小浪底水库": "济源市、洛阳市、三门峡市",
    "丹江口水库": "南阳市（跨湖北省十堰市）",
    "白沙水库": "许昌市、郑州市交界",
}


def read_features(path: Path):
    reader = shapefile.Reader(str(path), encoding="utf-8")
    for record, source_shape in zip(reader.records(), reader.shapes()):
        geom = make_valid(shape(source_shape.__geo_interface__))
        yield record.as_dict(), polygonal_only(geom)


def polygonal_only(geom):
    if isinstance(geom, (Polygon, MultiPolygon)):
        return geom
    if isinstance(geom, GeometryCollection):
        pieces = [part for part in geom.geoms if isinstance(part, (Polygon, MultiPolygon))]
        return unary_union(pieces)
    return geom


def feature(geometry, properties):
    return {
        "type": "Feature",
        "properties": properties,
        "geometry": mapping(geometry),
    }


def collection(features):
    return {"type": "FeatureCollection", "features": features}


def write_json(path: Path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )


def city_for(point, cities):
    matches = [name for name, geom in cities if geom.covers(point)]
    return "、".join(matches) if matches else "待核对"


def city_intersections(geom, cities):
    if geom.area == 0:
        return []
    matches = []
    for name, city_geom in cities:
        if not geom.intersects(city_geom):
            continue
        ratio = geom.intersection(city_geom).area / geom.area
        if ratio >= 0.0005:
            matches.append({"name": name, "geometry_ratio_pct": round(ratio * 100, 2)})
    return sorted(matches, key=lambda item: item["geometry_ratio_pct"], reverse=True)


def load_online_validation():
    records = []
    for filename in ("osm-nominatim-lookup.json", "osm-nominatim-missing-lookup.json"):
        path = VALIDATION_DIR / filename
        if not path.exists():
            continue
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
        records.extend(payload if isinstance(payload, list) else [payload])
    return {str(item["osm_id"]): item for item in records}


def main():
    missing = [
        str(path)
        for path in (RESERVOIR_SHP, CITY_SHP, PROVINCE_SHP, DANJIANG_HANJIANG_SHP)
        if not path.exists()
    ]
    if missing:
        raise FileNotFoundError("Missing GIS inputs:\n" + "\n".join(missing))

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    online_by_osm_id = load_online_validation()

    city_inputs = list(read_features(CITY_SHP))
    cities = [(props["name"], geom) for props, geom in city_inputs]
    city_features = [
        feature(
            geom.simplify(0.002, preserve_topology=True),
            {"name": props["name"], "gb": props.get("gb", "")},
        )
        for props, geom in city_inputs
    ]

    province_inputs = list(read_features(PROVINCE_SHP))
    province_features = [
        feature(
            geom.simplify(0.0015, preserve_topology=True),
            {"name": props.get("省", "河南省"), "code": props.get("省代码", 410000)},
        )
        for props, geom in province_inputs
    ]

    hanjiang_geometry = unary_union([geom for _, geom in read_features(DANJIANG_HANJIANG_SHP)])
    if hanjiang_geometry.is_empty:
        raise RuntimeError(f"Supplemental Hanjiang geometry is empty: {DANJIANG_HANJIANG_SHP}")

    reservoir_features = []
    quality_notes = []
    for index, (props, geom) in enumerate(read_features(RESERVOIR_SHP), start=1):
        original_name = (props.get("name") or "").strip()
        name = original_name or "彰武水库"
        supplemental_source = None
        if name == "丹江口水库":
            geom = polygonal_only(make_valid(unary_union([geom, hanjiang_geometry])))
            supplemental_source = "2024河流湖泊/丹江口水库/汉江.shp"
        point = geom.representative_point()
        area_m2, _ = GEOD.geometry_area_perimeter(geom)
        reservoir_code = f"HN_RSV_{index:03d}"
        osm_id = str(props.get("osm_id", ""))
        online = online_by_osm_id.get(osm_id)
        online_distance_m = None
        if online:
            _, _, online_distance_m = GEOD.inv(
                point.x,
                point.y,
                float(online["lon"]),
                float(online["lat"]),
            )
        spatial_cities = city_intersections(geom, cities)
        spatial_primary = spatial_cities[0]["name"] if spatial_cities else city_for(point, cities)
        official_city = OFFICIAL_CITY_BY_NAME.get(name, "待核对")
        city_display = CROSS_CITY_DISPLAY.get(name, official_city)

        reservoir_features.append(
            feature(
                geom.simplify(0.0006, preserve_topology=True),
                {
                    "id": reservoir_code,
                    "code": reservoir_code,
                    "name_cn": name,
                    "city": city_display,
                    "city_official": official_city,
                    "city_spatial_primary": spatial_primary,
                    "city_spatial_intersections": spatial_cities,
                    "lon": round(point.x, 6),
                    "lat": round(point.y, 6),
                    "area_km2": round(abs(area_m2) / 1_000_000, 2),
                    "area_definition": "SHP水面几何的WGS84椭球面积；随边界数据时相和水位变化",
                    "center_method": "polygon_representative_point",
                    "osm_id": osm_id,
                    "feature_class": props.get("fclass", ""),
                    "data_source": "河南省25个省控水库/25个省控水库.shp"
                    + (f" + {supplemental_source}" if supplemental_source else ""),
                    "geometry_status": "verified-valid-supplemented" if supplemental_source else (
                        "verified-valid" if geom.is_valid else "repaired"
                    ),
                    "online_name": online.get("namedetails", {}).get("name", "") if online else "",
                    "online_display_name": online.get("display_name", "") if online else "",
                    "online_center_offset_m": round(online_distance_m, 1) if online_distance_m is not None else None,
                    "online_validation_status": "matched-by-osm-id" if online else "official-city-only",
                },
            )
        )

        if not original_name:
            quality_notes.append(
                {
                    "code": reservoir_code,
                    "field": "name_cn",
                    "status": "needs-human-confirmation",
                    "note": "主图层名称为空；依据同目录、同 osm_id 和相同几何的“彰武水库.shp”补为彰武水库。",
                }
            )
        if supplemental_source:
            quality_notes.append(
                {
                    "code": reservoir_code,
                    "field": "geometry",
                    "status": "supplemented-from-local-source",
                    "note": "丹江口水库边界已合并汉江.shp中的2个WGS84河道水面多边形。",
                    "source": str(DANJIANG_HANJIANG_SHP),
                }
            )

    report = {
        "reservoir_count": len(reservoir_features),
        "crs": "EPSG:4326",
        "source": str(RESERVOIR_SHP),
        "city_boundary_source": str(CITY_SHP),
        "province_boundary_source": str(PROVINCE_SHP),
        "danjiang_hanjiang_source": str(DANJIANG_HANJIANG_SHP),
        "review_number": "GS（2024）0650号（行政区边界来源目录标识）",
        "online_validation": {
            "matched_osm_records": sum(
                1 for item in reservoir_features if item["properties"]["online_validation_status"] == "matched-by-osm-id"
            ),
            "method": "Nominatim按本地osm_id核对名称、地址和在线代表点；省级公开资料复核所在城市。",
            "sources": [
                "https://nominatim.openstreetmap.org/lookup",
                "https://sthjt.henan.gov.cn/2006/06-05/1320614.html",
                "https://zfcg.henan.gov.cn/hebi/content?infoId=1921937",
                "https://hnsggzyjy.henan.gov.cn/jyxx/002001/002001001/20251011/41581ad2-4fee-46b3-a16b-2e11bd301398.html",
                "https://slt.henan.gov.cn/2024/10-24/3077974.html",
            ],
        },
        "notes": quality_notes,
    }

    write_json(OUTPUT_DIR / "reservoirs.geojson", collection(reservoir_features))
    write_json(OUTPUT_DIR / "henan-cities.geojson", collection(city_features))
    write_json(OUTPUT_DIR / "henan-boundary.geojson", collection(province_features))
    write_json(OUTPUT_DIR / "data-quality-report.json", report)

    print(json.dumps(report, ensure_ascii=False, indent=2))
    if len(reservoir_features) != 25:
        raise RuntimeError(f"Expected 25 reservoirs, got {len(reservoir_features)}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"prepare_spatial_data failed: {exc}", file=sys.stderr)
        raise
