-- CRM responsibility and follow-up scheduling.
-- Run after 0002_crm_audit.sql.
ALTER TABLE leads ADD COLUMN assigned_to TEXT NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN follow_up_at TEXT NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0);

CREATE INDEX IF NOT EXISTS idx_leads_follow_up ON leads(follow_up_at, status);
CREATE INDEX IF NOT EXISTS idx_leads_assigned_to ON leads(assigned_to, created_at DESC);

CREATE TABLE IF NOT EXISTS lead_followup_audit (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  previous_assignee TEXT NOT NULL,
  new_assignee TEXT NOT NULL,
  previous_due TEXT NOT NULL,
  new_due TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_followup_audit_lead ON lead_followup_audit(lead_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_followup_audit_prevent_update
BEFORE UPDATE ON lead_followup_audit BEGIN
  SELECT RAISE(ABORT, 'follow-up audit records are append-only');
END;
