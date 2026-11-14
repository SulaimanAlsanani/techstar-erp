#!/usr/bin/env python3
"""TechStar Cloudflare staging readiness check.

Usage:
  python backend/scripts/check-staging.py
  python backend/scripts/check-staging.py --require-ready

Does not call Cloudflare or reveal secrets. The first form validates structure
and prints deployment blockers; the strict form exits nonzero if any blocker remains.
"""
from __future__ import annotations

import argparse
import re
import sys
import tomllib
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "wrangler.toml"
D1_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
NAMESPACE = re.compile(r"^[1-9][0-9]*$")


def validate(config: dict) -> tuple[list[str], list[str]]:
    problems: list[str] = []
    blockers: list[str] = []
    if config.get("main") != "src/index.mjs" or not (ROOT / "src/index.mjs").is_file():
        problems.append("Worker entrypoint must be src/index.mjs")
    if config.get("name") not in ("techstar-public-api", "techstar-public-api-staging"):
        problems.append("Unexpected Worker name")
    if not re.match(r"^20\d\d-\d\d-\d\d$", str(config.get("compatibility_date", ""))):
        problems.append("Invalid compatibility date")
    bindings = config.get("d1_databases") or []
    if len(bindings) != 1 or bindings[0].get("binding") != "DB":
        problems.append("Expected one D1 binding named DB")
    else:
        db = bindings[0]
        if db.get("database_name") not in ("techstar-leads", "techstar-leads-staging"):
            problems.append("D1 database_name must match techstar-leads")
        if db.get("migrations_dir") != "migrations":
            problems.append("D1 migrations_dir must be migrations")
        db_id = str(db.get("database_id", ""))
        if not D1_ID.fullmatch(db_id):
            blockers.append("Replace D1 database_id placeholder with a real UUID")
    limiters = config.get("ratelimits") or []
    if len(limiters) != 1 or limiters[0].get("name") != "LEAD_RATE_LIMITER":
        problems.append("Rate limiter binding LEAD_RATE_LIMITER is required")
    else:
        limiter = limiters[0]
        ns = str(limiter.get("namespace_id", ""))
        if not NAMESPACE.fullmatch(ns):
            blockers.append("Replace LEAD_RATE_LIMITER namespace_id with an account-specific integer")
        simple = limiter.get("simple") or {}
        if simple.get("limit") != 6 or simple.get("period") != 60:
            problems.append("Expected baseline rate limit 6 requests per 60 seconds")
    vars_ = config.get("vars") or {}
    ingestion=vars_.get("LEAD_INGESTION_ENABLED")
    if ingestion not in ("true", "false"):
        problems.append("LEAD_INGESTION_ENABLED must explicitly be true or false")
    if config.get("name") == "techstar-public-api-staging" and ingestion != "false":
        problems.append("Staging must never enable public lead ingestion")
    origins = str(vars_.get("ALLOWED_ORIGINS", "")).split(",")
    if not origins or any(not x.strip() for x in origins):
        problems.append("ALLOWED_ORIGINS must be a nonempty list of exact HTTPS origins")
    for origin in origins:
        p = urlparse(origin.strip())
        if p.scheme != "https" or not p.netloc or p.path not in ("", "/") or p.username or p.password or p.query or p.fragment:
            problems.append("Invalid ALLOWED_ORIGINS entry: must be an HTTPS origin without a path")
            break
    hostname = vars_.get("TURNSTILE_HOSTNAME", "")
    if not isinstance(hostname, str) or not hostname or "://" in hostname or "/" in hostname:
        problems.append("TURNSTILE_HOSTNAME must be a hostname, not a URL")
    if "TURNSTILE_SECRET" in vars_ or "ACCESS_AUD" in vars_ or "CRM_ADMIN_EMAILS" in vars_:
        problems.append("Confidential/runtime Access settings must not be committed as public vars")
    if config.get("triggers", {}).get("crons"):
        blockers.append("Cron triggers require approved retention policy and separate review")
    for path in ("0001_leads.sql", "0002_crm_audit.sql", "0003_crm_followup.sql"):
        if not (ROOT / "migrations" / path).is_file():
            problems.append(f"Required migration is missing: {path}")
    return problems, blockers


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--require-ready", action="store_true", help="Fail until staging prerequisites are configured")
    parser.add_argument("--config", type=Path, default=CONFIG, help="Wrangler TOML file to inspect")
    args = parser.parse_args()
    try:
        data = tomllib.loads(args.config.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as exc:
        print("Invalid wrangler.toml:", exc)
        return 1
    problems, blockers = validate(data)
    if problems:
        print("Configuration errors:")
        for item in problems:
            print("  -", item)
    if blockers:
        print("Staging prerequisites still missing:")
        for item in blockers:
            print("  -", item)
    if not problems and not blockers:
        print("Static staging configuration checks passed.")
    elif not problems:
        print("Configuration shape valid; staging is not ready yet.")
    if problems or (args.require_ready and blockers):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
