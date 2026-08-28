from __future__ import annotations

import argparse
import json

from ..database import Base, engine
from ..services.imagery import refresh_all_products


def main() -> None:
    parser = argparse.ArgumentParser(description="批量刷新25座水库的实际影像产品")
    parser.add_argument("--days", type=int, default=90)
    parser.add_argument("--limit-per-source", type=int, default=500)
    args = parser.parse_args()
    Base.metadata.create_all(bind=engine)
    print(json.dumps(
        refresh_all_products(args.days, args.limit_per_source),
        ensure_ascii=False,
        indent=2,
    ))


if __name__ == "__main__":
    main()
