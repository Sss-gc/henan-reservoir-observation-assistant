from __future__ import annotations

import argparse
import json

from ..database import Base, engine
from ..services.orbit import refresh_orbits


def main() -> None:
    parser = argparse.ArgumentParser(description="从 CelesTrak 刷新 OMM 并计算水库轨道覆盖窗口")
    parser.add_argument("--days", type=int, default=30, choices=range(1, 31))
    parser.add_argument("--force", action="store_true", help="忽略两小时缓存，强制下载")
    args = parser.parse_args()
    Base.metadata.create_all(bind=engine)
    print(json.dumps(refresh_orbits(days=args.days, force=args.force), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
