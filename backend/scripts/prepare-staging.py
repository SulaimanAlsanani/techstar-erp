#!/usr/bin/env python3
"""Generate an isolated, non-production Cloudflare Worker config.

Required environment variables:
  TECHSTAR_STAGING_D1_ID          UUID of a dedicated staging D1 database
  TECHSTAR_STAGING_RATE_NAMESPACE Positive integer namespace ID, unique to staging

This script never changes wrangler.toml or enables lead collection.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "wrangler.toml"
OUTPUT = ROOT / ".wrangler-staging.toml"
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


def main() -> None:
    db = os.environ.get("TECHSTAR_STAGING_D1_ID", "").strip()
    namespace = os.environ.get("TECHSTAR_STAGING_RATE_NAMESPACE", "").strip()
    if not UUID.fullmatch(db):
        raise SystemExit("TECHSTAR_STAGING_D1_ID is missing or not a valid UUID")
    if not re.fullmatch(r"[1-9][0-9]*", namespace):
        raise SystemExit("TECHSTAR_STAGING_RATE_NAMESPACE must be a positive integer string")
    text = TEMPLATE.read_text(encoding="utf-8")
    replacements = [
        ('name = "techstar-public-api"', 'name = "techstar-public-api-staging"'),
        ('database_name = "techstar-leads"', 'database_name = "techstar-leads-staging"'),
        ('database_id = "REPLACE_WITH_YOUR_D1_DATABASE_ID"', f'database_id = "{db}"'),
        ('namespace_id = "REPLACE_WITH_UNIQUE_INTEGER_NAMESPACE_ID"', f'namespace_id = "{namespace}"'),
    ]
    for old, new in replacements:
        if text.count(old) != 1:
            raise SystemExit(f"Unexpected staging template section: {old.split('=')[0].strip()}")
        text = text.replace(old, new)
    text = text.replace(
        'main = "src/index.mjs"',
        'main = "src/index.mjs"\nworkers_dev = true',
        1
    )
    # The generated configuration has no credentials or private keys.
    OUTPUT.write_text(text, encoding="utf-8")
    verify = subprocess.run([
        sys.executable, str(ROOT / "scripts/check-staging.py"),
        "--config", str(OUTPUT), "--require-ready"
    ], check=False)
    if verify.returncode:
        OUTPUT.unlink(missing_ok=True)
        raise SystemExit("Generated staging config failed validation")
    print("Staging configuration generated and validated (dedicated D1 and rate limit namespace).")
    print("No Cloudflare API calls were made, no Worker was deployed, and no data collection was activated.")


if __name__ == "__main__":
    main()
