from __future__ import annotations

import os
import secrets
from pathlib import Path

from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(PROJECT_ROOT / ".env", override=False)
PUBLIC_DATA_DIR = PROJECT_ROOT / "public" / "data"
BACKEND_DATA_DIR = PROJECT_ROOT / "backend" / "data"
BACKEND_DATA_DIR.mkdir(parents=True, exist_ok=True)

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    f"sqlite:///{(BACKEND_DATA_DIR / 'reservoir-observer.db').as_posix()}",
)
WEATHER_CACHE_TTL_SECONDS = int(os.getenv("WEATHER_CACHE_TTL_SECONDS", "10800"))
OPEN_METEO_URL = os.getenv("OPEN_METEO_URL", "https://api.open-meteo.com/v1/forecast")
APP_VERSION = "0.14.0"
CELESTRAK_GP_URL = os.getenv(
    "CELESTRAK_GP_URL",
    "https://celestrak.org/NORAD/elements/gp.php",
)
ORBIT_CACHE_TTL_SECONDS = int(os.getenv("ORBIT_CACHE_TTL_SECONDS", "7200"))
COPERNICUS_STAC_URL = os.getenv("COPERNICUS_STAC_URL", "https://stac.dataspace.copernicus.eu/v1")
USGS_LANDSAT_STAC_URL = os.getenv("USGS_LANDSAT_STAC_URL", "https://landsatlook.usgs.gov/stac-server")
IMAGERY_CACHE_TTL_SECONDS = int(os.getenv("IMAGERY_CACHE_TTL_SECONDS", "21600"))


def _admin_api_key() -> str:
    configured = os.getenv("ADMIN_API_KEY", "").strip()
    if configured:
        return configured
    key_file = BACKEND_DATA_DIR / "admin-api-key.txt"
    if key_file.exists():
        existing = key_file.read_text(encoding="utf-8").strip()
        if existing:
            return existing
    generated = secrets.token_urlsafe(32)
    key_file.write_text(generated + "\n", encoding="utf-8")
    try:
        key_file.chmod(0o600)
    except OSError:
        pass
    return generated


ADMIN_API_KEY = _admin_api_key()
SCHEDULER_ENABLED = os.getenv("SCHEDULER_ENABLED", "true").strip().lower() in {"1", "true", "yes", "on"}
SCHEDULER_IMAGERY_DAYS = int(os.getenv("SCHEDULER_IMAGERY_DAYS", "90"))
SCHEDULER_IMAGERY_LIMIT = int(os.getenv("SCHEDULER_IMAGERY_LIMIT", "500"))
DATABASE_BACKUP_ENABLED = os.getenv("DATABASE_BACKUP_ENABLED", "true").strip().lower() in {"1", "true", "yes", "on"}
DATABASE_BACKUP_HOUR = int(os.getenv("DATABASE_BACKUP_HOUR", "3"))
DATABASE_BACKUP_MINUTE = int(os.getenv("DATABASE_BACKUP_MINUTE", "30"))
DATABASE_BACKUP_RETENTION_DAYS = max(1, int(os.getenv("DATABASE_BACKUP_RETENTION_DAYS", "14")))
DATABASE_BACKUP_DIR = Path(
    os.getenv("DATABASE_BACKUP_DIR", str(BACKEND_DATA_DIR / "backups"))
).resolve()

ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ORIGINS",
        "http://127.0.0.1:5173,http://localhost:5173",
    ).split(",")
    if origin.strip()
]
