from __future__ import annotations

import argparse
import json
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

from ..services.backup import (
    create_database_backup,
    current_database_path,
    database_backup_status,
    restore_database_backup,
    verify_database_file,
)


def _backend_is_running() -> bool:
    try:
        with urlopen("http://127.0.0.1:8000/api/v1/health", timeout=1) as response:
            return response.status == 200
    except (OSError, URLError):
        return False


def main() -> None:
    parser = argparse.ArgumentParser(description="SQLite数据库备份、校验与恢复")
    commands = parser.add_subparsers(dest="command", required=True)
    backup = commands.add_parser("backup", help="创建在线一致性备份")
    backup.add_argument("--database", type=Path)
    backup.add_argument("--output-dir", type=Path)
    backup.add_argument("--retention-days", type=int, default=14)
    listing = commands.add_parser("list", help="查看备份状态")
    listing.add_argument("--output-dir", type=Path)
    verify = commands.add_parser("verify", help="执行SQLite完整性检查")
    verify.add_argument("backup", type=Path)
    restore = commands.add_parser("restore", help="恢复到指定数据库")
    restore.add_argument("backup", type=Path)
    restore.add_argument("--database", type=Path)
    restore.add_argument("--confirm-restore", action="store_true")
    args = parser.parse_args()

    if args.command == "backup":
        result = create_database_backup(args.database, args.output_dir, args.retention_days)
    elif args.command == "list":
        result = database_backup_status(args.output_dir)
    elif args.command == "verify":
        result = verify_database_file(args.backup)
    else:
        target = args.database.resolve() if args.database else current_database_path()
        if target == current_database_path() and _backend_is_running():
            parser.error("网站后端仍在运行。请先双击“ops\\windows\\停止网站.bat”，再执行恢复。")
        result = restore_database_backup(
            args.backup,
            target,
            confirmed=args.confirm_restore,
        )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
