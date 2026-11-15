-- CRM staff notes linked to each lead. Apply after 0004_crm_exports.sql.
CREATE TABLE IF NOT EXISTS lead_notes (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  body TEXT NOT NULL CHECK(length(trim(body)) BETWEEN 1 AND 1500),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_lead_notes_lead_created
ON lead_notes(lead_id, created_at DESC);
CREATE TRIGGER IF NOT EXISTS trg_lead_notes_no_update
BEFORE UPDATE ON lead_notes BEGIN
  SELECT RAISE(ABORT, 'CRM notes are append-only');
END;
