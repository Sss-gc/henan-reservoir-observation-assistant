from __future__ import annotations

import hashlib
import os
import sqlite3
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from ..config import DATABASE_BACKUP_DIR, DATABASE_BACKUP_RETENTION_DAYS
from ..database import engine


def current_database_path() -> Path:
    if engine.dialect.name != "sqlite" or not engine.url.database:
        raise RuntimeError("数据库备份当前只支持SQLite")
    return Path(str(engine.url.database)).resolve()


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_database_file(path: str | Path) -> dict[str, Any]:
    database_path = Path(path).resolve()
    if not database_path.is_file():
        raise FileNotFoundError(f"数据库文件不存在：{database_path}")
    try:
        with closing(sqlite3.connect(str(database_path))) as connection:
            rows = [row[0] for row in connection.execute("PRAGMA integrity_check").fetchall()]
            if rows != ["ok"]:
                raise ValueError("SQLite完整性检查失败：" + "; ".join(rows))
            table_count = connection.execute(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table'"
            ).fetchone()[0]
    except sqlite3.DatabaseError as exc:
        raise ValueError(f"不是有效的SQLite数据库：{exc}") from exc
    stat = database_path.stat()
    return {
        "path": str(database_path),
        "filename": database_path.name,
        "bytes": stat.st_size,
        "sha256": _sha256(database_path),
        "integrity": "ok",
        "table_count": table_count,
        "modified_at": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
    }


def _safe_backup_files(directory: Path) -> list[Path]:
    root = directory.resolve()
    if not root.exists():
        return []
    return sorted(
        (item for item in root.glob("*.sqlite3") if item.is_file() and item.resolve().parent == root),
        key=lambda item: item.stat().st_mtime,
        reverse=True,
    )


def create_database_backup(
    source_path: str | Path | None = None,
    output_dir: str | Path | None = None,
    retention_days: int = DATABASE_BACKUP_RETENTION_DAYS,
    prefix: str = "reservoir-observer",
) -> dict[str, Any]:
    source = Path(source_path).resolve() if source_path else current_database_path()
    if not source.is_file():
        raise FileNotFoundError(f"源数据库不存在：{source}")
    directory = Path(output_dir).resolve() if output_dir else DATABASE_BACKUP_DIR
    directory.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f")
    target = directory / f"{prefix}-{timestamp}.sqlite3"
    temporary = directory / f".{target.name}.tmp"
    try:
        with closing(sqlite3.connect(str(source))) as source_connection:
            with closing(sqlite3.connect(str(temporary))) as target_connection:
                source_connection.backup(target_connection)
        verification = verify_database_file(temporary)
        os.replace(temporary, target)
    finally:
        if temporary.exists():
            temporary.unlink()

    cutoff = datetime.now(timezone.utc) - timedelta(days=max(1, retention_days))
    pruned: list[str] = []
    for candidate in _safe_backup_files(directory):
        if candidate == target:
            continue
        modified = datetime.fromtimestamp(candidate.stat().st_mtime, timezone.utc)
        if modified < cutoff:
            candidate.unlink()
            pruned.append(candidate.name)
    return {
        **verification,
        "path": str(target.resolve()),
        "filename": target.name,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "retention_days": max(1, retention_days),
        "pruned_count": len(pruned),
        "pruned": pruned,
    }


def database_backup_status(output_dir: str | Path | None = None) -> dict[str, Any]:
    directory = Path(output_dir).resolve() if output_dir else DATABASE_BACKUP_DIR
    files = _safe_backup_files(directory)
    latest = None
    if files:
        stat = files[0].stat()
        latest = {
            "filename": files[0].name,
            "bytes": stat.st_size,
            "created_at": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
        }
    return {
        "directory": str(directory),
        "file_count": len(files),
        "bytes": sum(item.stat().st_size for item in files),
        "latest": latest,
    }


def restore_database_backup(
    backup_path: str | Path,
    target_path: str | Path,
    *,
    confirmed: bool = False,
    safety_backup_dir: str | Path | None = None,
) -> dict[str, Any]:
    if not confirmed:
        raise PermissionError("恢复会覆盖目标数据库，必须显式确认")
    backup = Path(backup_path).resolve()
    target = Path(target_path).resolve()
    if backup == target:
        raise ValueError("备份文件与目标数据库不能是同一个文件")
    backup_verification = verify_database_file(backup)
    target.parent.mkdir(parents=True, exist_ok=True)
    safety_backup = None
    if target.exists():
        safety_backup = create_database_backup(
            source_path=target,
            output_dir=safety_backup_dir,
            prefix="pre-restore",
        )
    temporary = target.parent / f".{target.name}.restore.tmp"
    try:
        if temporary.exists():
            temporary.unlink()
        with closing(sqlite3.connect(str(backup))) as source_connection:
            with closing(sqlite3.connect(str(temporary))) as target_connection:
                source_connection.backup(target_connection)
        verify_database_file(temporary)
        os.replace(temporary, target)
    finally:
        if temporary.exists():
            temporary.unlink()
    return {
        "restored": True,
        "source": backup_verification,
        "target": verify_database_file(target),
        "safety_backup": safety_backup,
    }
