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
    db.executescript((MIGRATIONS / "0004_crm_exports.sql").read_text(encoding="utf-8"))
    db.executescript((MIGRATIONS / "0005_crm_notes.sql").read_text(encoding="utf-8"))
    db.executescript((MIGRATIONS / "0006_followup_completions.sql").read_text(encoding="utf-8"))
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

    def test_export_audit_records_are_insertable_but_not_mutable(self):
        with self.db:
            self.db.execute(
                "INSERT INTO crm_export_audit "
                "(id,actor_email,record_count,filter_summary) VALUES (?,?,?,?)",
                ("export-1", "admin@example.test", 2, '{"searched":false}')
            )
        row = self.db.execute(
            "SELECT actor_email,record_count FROM crm_export_audit WHERE id='export-1'"
        ).fetchone()
        self.assertEqual(row["record_count"], 2)
        self.assertEqual(row["actor_email"], "admin@example.test")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "UPDATE crm_export_audit SET record_count=3 WHERE id='export-1'"
            )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "DELETE FROM crm_export_audit WHERE id='export-1'"
            )

    def test_export_audit_rejects_more_than_500_rows(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "INSERT INTO crm_export_audit "
                "(id,actor_email,record_count,filter_summary) VALUES (?,?,?,?)",
                ("export-2", "admin@example.test", 501, "{}")
            )

    def test_lead_notes_are_append_only(self):
        with self.db:
            self.db.execute(
                "INSERT INTO lead_notes (id,lead_id,actor_email,body) VALUES (?,?,?,?)",
                ("note-1", "lead-1", "manager@example.test", "اتصال بالعميل")
            )
        note = self.db.execute("SELECT body FROM lead_notes WHERE id='note-1'").fetchone()
        self.assertEqual(note["body"], "اتصال بالعميل")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE lead_notes SET body='modified' WHERE id='note-1'")
        with self.db:
            self.db.execute("DELETE FROM leads WHERE id='lead-1'")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM lead_notes").fetchone()[0], 0)

    def test_lead_note_length_is_enforced(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "INSERT INTO lead_notes (id,lead_id,actor_email,body) VALUES (?,?,?,?)",
                ("note-2", "lead-1", "admin@example.test", " ")
            )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "INSERT INTO lead_notes (id,lead_id,actor_email,body) VALUES (?,?,?,?)",
                ("note-3", "lead-1", "admin@example.test", "a" * 1501)
            )

    def test_followup_completion_clears_due_and_preserves_history(self):
        due = "2026-11-20T11:00:00.000Z"
        self.db.execute("UPDATE leads SET follow_up_at=? WHERE id='lead-1'", (due,))
        with self.db:
            update = self.db.execute(
                "UPDATE leads SET follow_up_at = '', revision = revision + 1, "
                "updated_at = datetime('now') WHERE id = ? AND revision = ? AND "
                "follow_up_at = ? AND status NOT IN ('won','lost','archived')",
                ("lead-1", 0, due)
            )
            audit = self.db.execute(
                "INSERT INTO lead_followup_completions (id,lead_id,actor_email,due_at) "
                "SELECT ?,id,?,? FROM leads WHERE id = ? AND revision = ? AND changes() = 1",
                ("done-1", "admin@example.test", due, "lead-1", 1)
            )
        self.assertEqual(update.rowcount, 1)
        self.assertEqual(audit.rowcount, 1)
        row = self.db.execute("SELECT follow_up_at,revision FROM leads WHERE id='lead-1'").fetchone()
        self.assertEqual(row["follow_up_at"], "")
        self.assertEqual(row["revision"], 1)
        log = self.db.execute("SELECT due_at,actor_email,completed_at FROM lead_followup_completions").fetchone()
        self.assertEqual(log["due_at"], due)
        self.assertEqual(log["actor_email"], "admin@example.test")
        self.assertTrue(log["completed_at"])
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE lead_followup_completions SET due_at='changed' WHERE id='done-1'")
        with self.db:
            self.db.execute("DELETE FROM leads WHERE id='lead-1'")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM lead_followup_completions").fetchone()[0], 0)

    def test_stale_completion_does_not_log_fake_success(self):
        due = "2026-11-20T11:00:00.000Z"
        self.db.execute("UPDATE leads SET follow_up_at=?, revision=2 WHERE id='lead-1'", (due,))
        with self.db:
            update = self.db.execute(
                "UPDATE leads SET follow_up_at = '', revision = revision + 1, "
                "updated_at = datetime('now') WHERE id = ? AND revision = ? AND "
                "follow_up_at = ? AND status NOT IN ('won','lost','archived')",
                ("lead-1", 1, due)
            )
            audit = self.db.execute(
                "INSERT INTO lead_followup_completions (id,lead_id,actor_email,due_at) "
                "SELECT ?,id,?,? FROM leads WHERE id = ? AND revision = ? AND changes() = 1",
                ("done-stale", "admin@example.test", due, "lead-1", 2)
            )
        self.assertEqual((update.rowcount, audit.rowcount), (0, 0))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM lead_followup_completions").fetchone()[0], 0)

    def test_unified_timeline_sqlite_activity(self):
        due = "2026-12-02T09:00:00.000Z"
        self.db.execute("INSERT INTO lead_audit (id,lead_id,actor_email,action,previous_status,new_status) VALUES (?,?,?,?,?,?)",
            ("event-status", "lead-1", "admin@example.test", "status_changed", "new", "in_progress"))
        self.db.execute("INSERT INTO lead_followup_audit (id,lead_id,actor_email,previous_assignee,new_assignee,previous_due,new_due) VALUES (?,?,?,?,?,?,?)",
            ("event-assignment", "lead-1", "admin@example.test", "", "viewer@example.test", "", due))
        self.db.execute("INSERT INTO lead_followup_completions (id,lead_id,actor_email,due_at) VALUES (?,?,?,?)",
            ("event-completion", "lead-1", "admin@example.test", due))
        self.db.execute("INSERT INTO lead_notes (id,lead_id,actor_email,body) VALUES (?,?,?,?)",
            ("event-note", "lead-1", "admin@example.test", "ملاحظة داخلية"))
        query = "SELECT id,'status' AS kind,actor_email,created_at,\n  json_object('from',previous_status,'to',new_status) AS detail FROM lead_audit WHERE lead_id = ?\nUNION ALL\nSELECT id,'assignment',actor_email,created_at,\n  json_object('fromAssignee',previous_assignee,'toAssignee',new_assignee,'fromDue',previous_due,'toDue',new_due)\n  FROM lead_followup_audit WHERE lead_id = ?\nUNION ALL\nSELECT id,'completion',actor_email,completed_at AS created_at,\n  json_object('dueAt',due_at) FROM lead_followup_completions WHERE lead_id = ?\nUNION ALL\nSELECT id,'note',actor_email,created_at,\n  json_object('text',body) FROM lead_notes WHERE lead_id = ?\nORDER BY created_at DESC,id DESC LIMIT 150"
        import json
        rows = self.db.execute(query, ("lead-1",) * 4).fetchall()
        self.assertEqual({row["kind"] for row in rows},
            {"status", "assignment", "completion", "note"})
        self.assertEqual(len(rows), 4)
        parsed = {r["kind"]:json.loads(r["detail"]) for r in rows}
        self.assertEqual(parsed["status"]["from"], "new")
        self.assertEqual(parsed["assignment"]["toAssignee"], "viewer@example.test")
        self.assertEqual(parsed["completion"]["dueAt"], due)
        self.assertEqual(parsed["note"]["text"], "ملاحظة داخلية")

    def test_crm_new_lead_attention_queries(self):
        self.db.execute(
            "UPDATE leads SET status='new', assigned_to='', created_at=datetime('now','-2 days') WHERE id='lead-1'"
        )
        unassigned_sql = "SELECT COUNT(*) FROM leads WHERE status='new' AND assigned_to=''"
        stale_sql = "SELECT COUNT(*) FROM leads WHERE status='new' AND created_at < datetime('now','-24 hours')"
        self.assertEqual(self.db.execute(unassigned_sql).fetchone()[0], 1)
        self.assertEqual(self.db.execute(stale_sql).fetchone()[0], 1)
        self.db.execute("UPDATE leads SET assigned_to='staff@example.test' WHERE id='lead-1'")
        self.assertEqual(self.db.execute(unassigned_sql).fetchone()[0], 0)
        self.assertEqual(self.db.execute(stale_sql).fetchone()[0], 1)
        self.db.execute("UPDATE leads SET status='in_progress' WHERE id='lead-1'")
        self.assertEqual(self.db.execute(stale_sql).fetchone()[0], 0)

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
