from __future__ import annotations

from apscheduler.schedulers.background import BackgroundScheduler

from .config import (
    DATABASE_BACKUP_ENABLED,
    DATABASE_BACKUP_HOUR,
    DATABASE_BACKUP_MINUTE,
    DATABASE_BACKUP_RETENTION_DAYS,
    SCHEDULER_IMAGERY_DAYS,
    SCHEDULER_IMAGERY_LIMIT,
)
from .services.backup import create_database_backup
from .services.imagery import refresh_all_products
from .services.orbit import refresh_orbits


scheduler = BackgroundScheduler(timezone="Asia/Shanghai")


def start_scheduler() -> None:
    if scheduler.running:
        return
    scheduler.add_job(
        refresh_orbits,
        "interval",
        hours=2,
        args=[30, False],
        id="refresh-orbits",
        replace_existing=True,
        coalesce=True,
        max_instances=1,
        misfire_grace_time=1800,
    )
    scheduler.add_job(
        refresh_all_products,
        "cron",
        hour=2,
        minute=30,
        args=[SCHEDULER_IMAGERY_DAYS, SCHEDULER_IMAGERY_LIMIT],
        id="refresh-all-imagery",
        replace_existing=True,
        coalesce=True,
        max_instances=1,
        misfire_grace_time=3600,
    )
    if DATABASE_BACKUP_ENABLED:
        scheduler.add_job(
            create_database_backup,
            "cron",
            hour=DATABASE_BACKUP_HOUR,
            minute=DATABASE_BACKUP_MINUTE,
            kwargs={"retention_days": DATABASE_BACKUP_RETENTION_DAYS},
            id="backup-database",
            replace_existing=True,
            coalesce=True,
            max_instances=1,
            misfire_grace_time=3600,
        )
    scheduler.start()


def stop_scheduler() -> None:
    if scheduler.running:
        scheduler.shutdown(wait=False)


def scheduler_snapshot() -> dict:
    return {
        "enabled": True,
        "running": scheduler.running,
        "timezone": str(scheduler.timezone),
        "jobs": [
            {
                "id": job.id,
                "name": job.name,
                "next_run_time": job.next_run_time.isoformat() if job.next_run_time else None,
            }
            for job in scheduler.get_jobs()
        ],
    }
