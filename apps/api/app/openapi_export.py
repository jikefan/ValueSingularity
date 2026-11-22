"""Deterministic OpenAPI schema exporter and drift checker."""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from pathlib import Path

from app.main import create_app


def render_openapi_json() -> str:
    schema = create_app().openapi()
    return json.dumps(schema, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Export or verify the FastAPI OpenAPI schema.")
    parser.add_argument("output", help="Path to openapi.json")
    parser.add_argument(
        "--check",
        action="store_true",
        help="Verify output matches the current app schema without writing.",
    )
    args = parser.parse_args(argv)

    output_path = Path(args.output)
    rendered = render_openapi_json()

    if args.check:
        if not output_path.exists() or output_path.read_text(encoding="utf-8") != rendered:
            print(
                f"契约未同步：{args.output} 与后端模型不一致，请在仓库根目录运行 make gen-api。",
                file=sys.stderr,
            )
            return 1
        return 0

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(rendered, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
