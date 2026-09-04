from __future__ import annotations


CELESTRAK_RESOURCE_TABLE = "https://celestrak.org/norad/elements/table.php?FORMAT=tle&GROUP=resource"

# Only missions with an unambiguous, documented imaging swath are enabled for
# geometric prediction. Registered missions remain visible in the API, but do
# not produce misleading coverage figures until a sensor mode is selected.
SATELLITE_CATALOG = [
    {
        "id": "sentinel-2a", "name": "Sentinel-2A", "norad_cat_id": 40697,
        "intl_designator": "2015-028A", "sensor": "MSI", "swath_km": 290.0,
        "prediction_enabled": True, "catalog_status": "active",
    },
    {
        "id": "sentinel-2b", "name": "Sentinel-2B", "norad_cat_id": 42063,
        "intl_designator": "2017-013A", "sensor": "MSI", "swath_km": 290.0,
        "prediction_enabled": True, "catalog_status": "active",
    },
    {
        "id": "sentinel-2c", "name": "Sentinel-2C", "norad_cat_id": 60989,
        "intl_designator": "2024-157A", "sensor": "MSI", "swath_km": 290.0,
        "prediction_enabled": True, "catalog_status": "active",
    },
    {
        "id": "landsat-8", "name": "Landsat 8", "norad_cat_id": 39084,
        "intl_designator": "2013-008A", "sensor": "OLI/TIRS", "swath_km": 185.0,
        "prediction_enabled": True, "catalog_status": "active",
    },
    {
        "id": "landsat-9", "name": "Landsat 9", "norad_cat_id": 49260,
        "intl_designator": "2021-088A", "sensor": "OLI-2/TIRS-2", "swath_km": 185.0,
        "prediction_enabled": True, "catalog_status": "active",
    },
    {
        "id": "hj-2b", "name": "HJ-2B", "norad_cat_id": 46479,
        "intl_designator": "2020-067B", "sensor": "CCD1–CCD4 (16 m，四相机拼接)", "swath_km": 800.0,
        "prediction_enabled": True, "catalog_status": "orbit-trackable-wide-view",
    },
    {
        "id": "gaofen-1", "name": "Gaofen-1", "norad_cat_id": 39150,
        "intl_designator": "2013-018A", "sensor": "16m WFV (4-camera composite)", "swath_km": 800.0,
        "prediction_enabled": True, "catalog_status": "orbit-trackable-wide-view",
    },
]


DOMESTIC_MISSION_METADATA = {
    "hj-2b": {
        "prediction_mode": "16m CCD1-CCD4 four-camera composite",
        "resolution_m": 16.0,
        "swath_basis": "official measured swath >800km; 800km used conservatively",
        "documentation_url": "https://www.cnsa.gov.cn/n6758823/n6758838/c6810270/content.html",
        "product_catalog_url": "https://www.cpeos.org.cn/dataSearch3D/#/",
        "product_provider": "国家遥感数据与应用服务平台 / 中国资源卫星应用中心",
        "product_api_status": "account-portal-no-documented-anonymous-api",
        "actual_products_integrated": False,
    },
    "gaofen-1": {
        "prediction_mode": "16m WFV four-camera composite",
        "resolution_m": 16.0,
        "swath_basis": "official WFV swath 800km",
        "documentation_url": "https://www.cnsa.gov.cn/n6758824/n6759009/n6759041/n6759072/c6809687/content.html",
        "product_catalog_url": "https://www.cpeos.org.cn/dataSearch3D/#/",
        "product_provider": "国家遥感数据与应用服务平台 / 中国资源卫星应用中心",
        "product_api_status": "account-portal-no-documented-anonymous-api",
        "actual_products_integrated": False,
    },
}
