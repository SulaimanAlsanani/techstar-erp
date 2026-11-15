#!/usr/bin/env python3
"""Restore-drill using a temporary local SQLite backup and synthetic CRM records.

This is NOT a Cloudflare D1 remote backup. It verifies the migration model,
foreign keys, audit integrity and recovery procedure on disposable databases.
"""
from __future__ import annotations

import sqlite3
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "migrations"
ID = "b0db5cc9-07db-4f4f-9957-517189c00001"
REQUEST_ID = "b0db5cc9-07db-4f4f-9957-517189c00002"
STAFF = "manager@fictional.example"


def setup():
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys=ON")
    migrations = sorted(MIGRATIONS.glob("[0-9][0-9][0-9][0-9]_*.sql"))
    assert len(migrations) >= 6, "Expected all CRM schema migrations"
    for migration in migrations:
        db.executescript(migration.read_text(encoding="utf-8"))
    return db


def seed(db):
    with db:
        db.execute(
            "INSERT INTO leads "
            "(id,client_request_id,reference,name,business,email,phone,branches,pos_count) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (ID, REQUEST_ID, "TS-RECOVERY-TEST", "Synthetic Customer",
             "Fictional Retail", "person@fictional.example", "0500000000", 1, 1),
        )
        db.execute(
            "INSERT INTO lead_audit "
            "(id,lead_id,actor_email,action,previous_status,new_status) "
            "VALUES (?,?,?,?,?,?)",
            ("status-test", ID, STAFF, "status_changed", "new", "in_progress"),
        )
        db.execute(
            "INSERT INTO lead_followup_audit "
            "(id,lead_id,actor_email,previous_assignee,new_assignee,previous_due,new_due) "
            "VALUES (?,?,?,?,?,?,?)",
            ("assigned-test", ID, STAFF, "", STAFF, "", "2026-12-05T09:00:00.000Z"),
        )
        db.execute(
            "INSERT INTO lead_notes (id,lead_id,actor_email,body) VALUES (?,?,?,?)",
            ("note-test", ID, STAFF, "A synthetic client follow-up note"),
        )
        db.execute(
            "INSERT INTO lead_followup_completions "
            "(id,lead_id,actor_email,due_at) VALUES (?,?,?,?)",
            ("completed-test", ID, STAFF, "2026-12-05T09:00:00.000Z"),
        )
        db.execute(
            "INSERT INTO crm_export_audit "
            "(id,actor_email,record_count,filter_summary) VALUES (?,?,?,?)",
            ("export-test", STAFF, 1, '{"searched":false}'),
        )


def snapshot(db):
    tables = (
        "leads", "lead_audit", "lead_followup_audit",
        "lead_notes", "lead_followup_completions", "crm_export_audit"
    )
    return {
        name: db.execute("SELECT COUNT(*) FROM " + name).fetchone()[0]
        for name in tables
    }


def check_integrity(db):
    assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert not db.execute("PRAGMA foreign_key_check").fetchall()


def main():
    source = setup()
    try:
        seed(source)
        check_integrity(source)
        original = snapshot(source)
        assert all(v == 1 for v in original.values())
        with tempfile.TemporaryDirectory(prefix="techstar-local-backup-") as temp:
            file_path = Path(temp) / "synthetic-crm.sqlite"
            archive = sqlite3.connect(file_path)
            try:
                source.backup(archive)
            finally:
                archive.close()
            restored = sqlite3.connect(":memory:")
            restored.execute("PRAGMA foreign_keys=ON")
            try:
                disk = sqlite3.connect(file_path)
                try:
                    disk.backup(restored)
                finally:
                    disk.close()
                check_integrity(restored)
                assert snapshot(restored) == original, "Recovered record counts differ"
                assert restored.execute(
                    "SELECT body FROM lead_notes WHERE lead_id=?", (ID,)
                ).fetchone()[0] == "A synthetic client follow-up note"
                try:
                    restored.execute(
                        "UPDATE lead_audit SET new_status='tampered' WHERE id='status-test'"
                    )
                except sqlite3.IntegrityError:
                    restored.rollback()
                else:
                    raise AssertionError("Restored status audit must be immutable")
                with restored:
                    restored.execute("DELETE FROM leads WHERE id=?", (ID,))
                after = snapshot(restored)
                assert after["crm_export_audit"] == 1
                assert all(
                    count == 0 for name, count in after.items()
                    if name != "crm_export_audit"
                ), "Lead-linked audit records did not cascade on deletion"
            finally:
                restored.close()
        print("PASS: temporary SQLite backup/restore, integrity checks, CRM audits and cascades.")
        print("Only synthetic records were used. No remote Cloudflare backup was created.")
    finally:
        source.close()


if __name__ == "__main__":
    main()
