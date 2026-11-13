#!/usr/bin/env python3
"""Sync the separate Hugging Face Space entrypoint from the canonical v5 backend.

Run `python3 scripts/sync-huggingface-space.py` after backend edits, or use
`--check` before release to detect source drift. This script only edits the local
repository; it never creates or deploys a Space.
"""
from __future__ import annotations

import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "colab/accentlab_seedvc_backend.py"
DESTINATION = ROOT / "huggingface-space/app.py"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail if app.py is out of sync")
    args = parser.parse_args()
    canonical = SOURCE.read_text(encoding="utf-8")
    current = DESTINATION.read_text(encoding="utf-8") if DESTINATION.exists() else ""
    if args.check:
        if current != canonical:
            print("HF Space entrypoint is stale; run scripts/sync-huggingface-space.py.")
            return 1
        print("HF Space entrypoint matches the canonical v5 backend.")
        return 0
    DESTINATION.parent.mkdir(parents=True, exist_ok=True)
    DESTINATION.write_text(canonical, encoding="utf-8")
    print("Synchronized HF Space entrypoint from the canonical v5 backend.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
