#!/usr/bin/env python3
"""Validate TechStar Cloudflare D1 SQLite schema and atomic status-audit logic."""
from __future__ import annotations

import sqlite3
import unittest
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]
MIGRATIONS = BASE / "migrations"

LEAD_COLUMNS = (
    "id, client_request_id, reference, name, business, email, phone, "
    "industry, package_id, solution_id, branches, pos_count, notes, created_at"
)
UPDATE_QUERY = (
    "UPDATE leads SET status = ?, updated_at = datetime('now') "
    "WHERE id = ? AND status = ?"
)
AUDIT_QUERY = (
    "INSERT INTO lead_audit (id,lead_id,actor_email,action,previous_status,new_status) "
    "SELECT ?,id,?,'status_changed',?,? FROM leads "
    "WHERE id = ? AND status = ? AND changes() = 1"
)


def setup_connection(preexisting=True):
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    db.executescript((MIGRATIONS / "0001_leads.sql").read_text(encoding="utf-8"))
    if preexisting:
        db.execute(
            f"INSERT INTO leads ({LEAD_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                "lead-1", "req-1", "TS-EXAMPLE", "User", "Example Shop",
                "mail@example.test", "0500000000", "retail", "gold", "pos",
                2, 3, "Test note", "2026-11-01 10:00:00"
            ),
        )
        db.commit()
    db.executescript((MIGRATIONS / "0002_crm_audit.sql").read_text(encoding="utf-8"))
    return db


def change_status(db, previous, desired, event_id="audit-1"):
    with db:
        update = db.execute(UPDATE_QUERY, (desired, "lead-1", previous))
        audit = db.execute(
            AUDIT_QUERY,
            (event_id, "lead-1", "staff@example.test", previous, desired, "lead-1", desired)
        )
        return update.rowcount, audit.rowcount


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.db = setup_connection()

    def tearDown(self):
        self.db.close()

    def test_old_leads_receive_updated_timestamp(self):
        row = self.db.execute(
            "SELECT created_at, updated_at FROM leads WHERE id='lead-1'"
        ).fetchone()
        self.assertEqual(row["updated_at"], row["created_at"])

    def test_status_update_records_single_audit_event(self):
        self.assertEqual(change_status(self.db, "new", "in_progress"), (1, 1))
        row = self.db.execute("SELECT status FROM leads WHERE id='lead-1'").fetchone()
        self.assertEqual(row["status"], "in_progress")
        events = self.db.execute("SELECT * FROM lead_audit").fetchall()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["previous_status"], "new")
        self.assertEqual(events[0]["new_status"], "in_progress")

    def test_conflicting_status_update_does_not_create_audit_event(self):
        self.assertEqual(change_status(self.db, "in_progress", "won"), (0, 0))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM lead_audit").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT status FROM leads").fetchone()[0], "new")

    def test_audit_events_cannot_be_rewritten(self):
        change_status(self.db, "new", "in_progress")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE lead_audit SET new_status='lost' WHERE id='audit-1'")
        self.assertEqual(
            self.db.execute("SELECT new_status FROM lead_audit").fetchone()[0],
            "in_progress"
        )

    def test_customer_record_cleanup_cascades_to_its_audit(self):
        change_status(self.db, "new", "in_progress")
        with self.db:
            self.db.execute("DELETE FROM leads WHERE id = ?", ("lead-1",))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM lead_audit").fetchone()[0], 0)

    def test_unique_client_request_id_enforced(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                f"INSERT INTO leads ({LEAD_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    "lead-2", "req-1", "TS-OTHER", "Test", "Test",
                    "mail@example.test", "0500000000", "", "gold", "",
                    1, 0, "", "2026-11-02 00:00:00"
                ),
            )

    def test_invalid_branch_count_rejected(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                f"INSERT INTO leads ({LEAD_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    "lead-3", "req-3", "TS-BAD", "Test", "Test",
                    "mail@example.test", "0500000000", "", "gold", "",
                    0, 0, "", "2026-11-02 00:00:00"
                ),
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
