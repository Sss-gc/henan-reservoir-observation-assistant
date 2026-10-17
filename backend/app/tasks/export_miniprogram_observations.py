"""Independently recalculate mini-program observations; do not read website batches."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from .export_static_observations import OUTPUT_PATH, build_static_payload
from ..database import Base, SessionLocal, engine
from ..services.orbit import refresh_orbits


def main() -> None:
    parser = argparse.ArgumentParser(description="独立生成小程序静态轨道数据")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    if output == OUTPUT_PATH.resolve():
        raise ValueError("小程序独立任务不能覆盖网站轨道文件")
    Base.metadata.create_all(bind=engine)
    result = refresh_orbits(days=30, force=True)
    if result["downloaded"] != result["expected_satellites"]:
        raise RuntimeError("未取得全部卫星的最新轨道，本次不发布")
    with SessionLocal() as db:
        payload = build_static_payload(db, 30)
    if not payload["items"]:
        raise RuntimeError("未生成有效观测窗口，本次不发布")
    for item in payload["items"]:
        item["id"] = str(item["id"])
    payload["pipeline"] = "miniprogram-static-independent-v1"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({"generated_at": payload["generated_at"], "items": len(payload["items"]),
                      "downloaded": result["downloaded"], "pipeline": payload["pipeline"]}))


if __name__ == "__main__":
    main()
