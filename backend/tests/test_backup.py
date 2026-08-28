from __future__ import annotations

import os
import sqlite3
from contextlib import closing
from datetime import datetime, timedelta, timezone

import pytest

from backend.app.services.backup import (
    create_database_backup,
    database_backup_status,
    restore_database_backup,
    verify_database_file,
)


def _database(path, value: str) -> None:
    with closing(sqlite3.connect(path)) as connection:
        connection.execute("CREATE TABLE sample (value TEXT NOT NULL)")
        connection.execute("INSERT INTO sample VALUES (?)", (value,))
        connection.commit()


def _value(path) -> str:
    with closing(sqlite3.connect(path)) as connection:
        return connection.execute("SELECT value FROM sample").fetchone()[0]


def test_backup_verify_and_restore_round_trip(tmp_path) -> None:
    source = tmp_path / "source.db"
    target = tmp_path / "target.db"
    backup_dir = tmp_path / "backups"
    _database(source, "original")
    _database(target, "replacement")

    backup = create_database_backup(source, backup_dir, retention_days=14)
    assert backup["integrity"] == "ok"
    assert backup["sha256"]
    assert verify_database_file(backup["path"])["table_count"] == 1
    restored = restore_database_backup(
        backup["path"], target, confirmed=True, safety_backup_dir=backup_dir
    )
    assert restored["restored"] is True
    assert restored["safety_backup"]["filename"].startswith("pre-restore-")
    assert _value(target) == "original"


def test_restore_requires_explicit_confirmation(tmp_path) -> None:
    source = tmp_path / "source.db"
    target = tmp_path / "target.db"
    _database(source, "original")
    _database(target, "replacement")
    with pytest.raises(PermissionError):
        restore_database_backup(source, target)
    assert _value(target) == "replacement"


def test_backup_retention_prunes_only_expired_sqlite_backups(tmp_path) -> None:
    source = tmp_path / "source.db"
    backup_dir = tmp_path / "backups"
    backup_dir.mkdir()
    _database(source, "current")
    old = backup_dir / "old.sqlite3"
    _database(old, "old")
    timestamp = (datetime.now(timezone.utc) - timedelta(days=30)).timestamp()
    os.utime(old, (timestamp, timestamp))
    unrelated = backup_dir / "keep.txt"
    unrelated.write_text("keep", encoding="utf-8")

    result = create_database_backup(source, backup_dir, retention_days=14)
    status = database_backup_status(backup_dir)
    assert result["pruned"] == ["old.sqlite3"]
    assert status["file_count"] == 1
    assert unrelated.read_text(encoding="utf-8") == "keep"


def test_corrupt_database_is_rejected(tmp_path) -> None:
    corrupt = tmp_path / "corrupt.sqlite3"
    corrupt.write_bytes(b"not-a-sqlite-database")
    with pytest.raises(ValueError):
        verify_database_file(corrupt)
