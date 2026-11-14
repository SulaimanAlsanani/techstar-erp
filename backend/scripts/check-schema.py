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
    "UPDATE leads SET status = ?, updated_at = datetime('now'), revision = revision + 1 "
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
    db.executescript((MIGRATIONS / "0003_crm_followup.sql").read_text(encoding="utf-8"))
    return db


def change_status(db, previous, desired, event_id="audit-1"):
    with db:
        update = db.execute(UPDATE_QUERY, (desired, "lead-1", previous))
        audit = db.execute(
            AUDIT_QUERY,
            (event_id, "staff@example.test", previous, desired, "lead-1", desired)
        )
        return update.rowcount, audit.rowcount


FOLLOWUP_UPDATE_QUERY = (
    "UPDATE leads SET assigned_to = ?, follow_up_at = ?, revision = revision + 1, "
    "updated_at = datetime('now') WHERE id = ? AND revision = ?"
)
FOLLOWUP_AUDIT_QUERY = (
    "INSERT INTO lead_followup_audit "
    "(id,lead_id,actor_email,previous_assignee,new_assignee,previous_due,new_due) "
    "SELECT ?,id,?,?,?,?,? FROM leads WHERE id = ? AND revision = ? AND changes() = 1"
)


def change_followup(db, expected_revision=0, assignee="staff@example.test",
                    followup="2026-12-01T10:00:00.000Z"):
    old = db.execute(
        "SELECT assigned_to,follow_up_at,revision FROM leads WHERE id='lead-1'"
    ).fetchone()
    with db:
        update = db.execute(
            FOLLOWUP_UPDATE_QUERY, (assignee, followup, "lead-1", expected_revision)
        )
        audit = db.execute(
            FOLLOWUP_AUDIT_QUERY,
            ("followup-audit-1", "manager@example.test", old["assigned_to"],
             assignee, old["follow_up_at"], followup,
             "lead-1", expected_revision + 1)
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

    def test_followup_audit_and_revision(self):
        self.assertEqual(change_followup(self.db), (1, 1))
        row = self.db.execute(
            "SELECT assigned_to,follow_up_at,revision FROM leads WHERE id='lead-1'"
        ).fetchone()
        self.assertEqual(row["assigned_to"], "staff@example.test")
        self.assertEqual(row["revision"], 1)
        self.assertEqual(row["follow_up_at"], "2026-12-01T10:00:00.000Z")
        audit = self.db.execute("SELECT * FROM lead_followup_audit").fetchone()
        self.assertEqual(audit["previous_assignee"], "")
        self.assertEqual(audit["new_assignee"], "staff@example.test")
        self.assertEqual(audit["actor_email"], "manager@example.test")

    def test_stale_followup_update_creates_no_second_audit(self):
        self.assertEqual(change_followup(self.db), (1, 1))
        self.assertEqual(
            change_followup(self.db, expected_revision=0, assignee="other@example.test"),
            (0, 0)
        )
        self.assertEqual(
            self.db.execute("SELECT COUNT(*) FROM lead_followup_audit").fetchone()[0], 1
        )

    def test_followup_audit_is_append_only(self):
        change_followup(self.db)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "UPDATE lead_followup_audit SET new_assignee='fake@example.test'"
            )

    def test_status_revision_invalidates_stale_followup(self):
        self.assertEqual(change_status(self.db, "new", "in_progress"), (1, 1))
        row = self.db.execute("SELECT revision FROM leads WHERE id='lead-1'").fetchone()
        self.assertEqual(row["revision"], 1)
        self.assertEqual(change_followup(self.db, expected_revision=0), (0, 0))

    def test_followup_audit_cascades_when_lead_is_removed(self):
        change_followup(self.db)
        with self.db:
            self.db.execute("DELETE FROM leads WHERE id='lead-1'")
        self.assertEqual(
            self.db.execute("SELECT COUNT(*) FROM lead_followup_audit").fetchone()[0],
            0
        )

    def test_followup_dashboard_counts_only_open_and_due_records(self):
        base = (
            "SELECT COUNT(*) AS total FROM leads WHERE follow_up_at <> '' "
            "AND status NOT IN ('won','lost','archived') AND "
        )
        overdue_sql = (
            base + "follow_up_at < strftime('%Y-%m-%dT%H:%M:%fZ','now')"
        )
        upcoming_sql = (
            base + "follow_up_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now') "
            "AND follow_up_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','+7 days')"
        )
        self.db.execute(
            "UPDATE leads SET follow_up_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day') "
            "WHERE id = 'lead-1'"
        )
        self.assertEqual(self.db.execute(overdue_sql).fetchone()[0], 1)
        self.assertEqual(self.db.execute(upcoming_sql).fetchone()[0], 0)
        self.db.execute(
            "UPDATE leads SET follow_up_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','+3 days') "
            "WHERE id = 'lead-1'"
        )
        self.assertEqual(self.db.execute(overdue_sql).fetchone()[0], 0)
        self.assertEqual(self.db.execute(upcoming_sql).fetchone()[0], 1)
        self.db.execute("UPDATE leads SET status='archived' WHERE id='lead-1'")
        self.assertEqual(self.db.execute(upcoming_sql).fetchone()[0], 0)

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
