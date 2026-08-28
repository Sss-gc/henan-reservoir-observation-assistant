FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY backend/requirements.txt /app/backend/requirements.txt
RUN python -m pip install --upgrade pip && \
    python -m pip install -r /app/backend/requirements.txt

COPY alembic.ini /app/alembic.ini
COPY backend /app/backend
COPY public /app/public
COPY deploy/docker/backend-entrypoint.sh /usr/local/bin/reservoir-entrypoint

RUN chmod +x /usr/local/bin/reservoir-entrypoint && \
    mkdir -p /app/backend/data

EXPOSE 8000
ENTRYPOINT ["reservoir-entrypoint"]
