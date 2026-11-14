-- CRM administration: optimistic status changes and immutable audit trail.
-- Apply after 0001_leads.sql; never collect production data before approval.
ALTER TABLE leads ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_leads_updated ON leads(updated_at DESC);

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
