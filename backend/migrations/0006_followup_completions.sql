-- Record completed scheduled follow-ups without silently losing the due date.
-- Apply after 0005_crm_notes.sql.
CREATE TABLE IF NOT EXISTS lead_followup_completions (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  due_at TEXT NOT NULL CHECK(length(due_at) > 0),
  completed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_lead_followup_completions_lead
  ON lead_followup_completions(lead_id,completed_at DESC);
CREATE TRIGGER IF NOT EXISTS trg_followup_completions_no_update
BEFORE UPDATE ON lead_followup_completions BEGIN
  SELECT RAISE(ABORT, 'completed follow-ups are append-only');
END;
