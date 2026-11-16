#!/usr/bin/env python3
"""Regression tests for strict separation between staging and production D1."""
import copy
import importlib.util
import tomllib
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("staging_check", ROOT / "scripts/check-staging.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class StagingIsolationTests(unittest.TestCase):
    def setUp(self):
        self.config = tomllib.loads((ROOT / "wrangler.toml").read_text(encoding="utf-8"))

    def staging(self):
        config = copy.deepcopy(self.config)
        config["name"] = "techstar-public-api-staging"
        config["d1_databases"][0]["database_name"] = "techstar-leads-staging"
        config["d1_databases"][0]["database_id"] = "00000000-0000-4000-8000-000000000001"
        config["ratelimits"][0]["namespace_id"] = "321890"
        return config

    def test_staging_config_matches_dedicated_d1(self):
        problems, blockers = MODULE.validate(self.staging())
        self.assertEqual(problems, [])
        self.assertEqual(blockers, [])

    def test_staging_cannot_bind_production_d1(self):
        config = self.staging()
        config["d1_databases"][0]["database_name"] = "techstar-leads"
        problems, _ = MODULE.validate(config)
        self.assertIn("Worker and D1 database must belong to the same environment", problems)

    def test_production_cannot_bind_staging_d1(self):
        config = self.staging()
        config["name"] = "techstar-public-api"
        problems, _ = MODULE.validate(config)
        self.assertIn("Worker and D1 database must belong to the same environment", problems)

    def test_staging_cannot_enable_lead_ingestion(self):
        config = self.staging()
        config["vars"]["LEAD_INGESTION_ENABLED"] = "true"
        problems, _ = MODULE.validate(config)
        self.assertIn("Staging must never enable public lead ingestion", problems)


if __name__ == "__main__":
    unittest.main()
