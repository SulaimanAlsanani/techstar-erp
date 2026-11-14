-- CRM administration: optimistic status changes and immutable audit trail.
-- Apply after 0001_leads.sql; never collect production data before approval.
ALTER TABLE leads ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_leads_updated ON leads(updated_at DESC);
-- Fill prior leads so administrative sorting and timestamps remain meaningful.
UPDATE leads SET updated_at = created_at WHERE updated_at = '';

CREATE TABLE IF NOT EXISTS lead_audit (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('status_changed')),
  previous_status TEXT NOT NULL,
  new_status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_lead_audit_lead ON lead_audit(lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_audit_created ON lead_audit(created_at DESC);
-- Audit records may be purged together with their lead to honor retention
-- policies, but existing event rows cannot be rewritten.
CREATE TRIGGER IF NOT EXISTS trg_lead_audit_prevent_update
BEFORE UPDATE ON lead_audit BEGIN
  SELECT RAISE(ABORT, 'lead audit records are append-only');
END;
