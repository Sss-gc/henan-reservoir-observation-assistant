#!/bin/sh
set -eu

cd /app
python -m alembic upgrade head
exec python -m uvicorn backend.app.main:app \
  --host 0.0.0.0 \
  --port 8000 \
  --proxy-headers \
  --forwarded-allow-ips="*"
