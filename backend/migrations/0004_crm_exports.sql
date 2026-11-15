-- Audit every CRM spreadsheet export before returning customer data.
-- Apply after 0003_crm_followup.sql.
CREATE TABLE IF NOT EXISTS crm_export_audit (
  id TEXT PRIMARY KEY,
  actor_email TEXT NOT NULL,
  record_count INTEGER NOT NULL CHECK(record_count BETWEEN 0 AND 500),
  filter_summary TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_crm_export_audit_created
ON crm_export_audit(created_at DESC);
CREATE TRIGGER IF NOT EXISTS trg_crm_export_audit_no_update
BEFORE UPDATE ON crm_export_audit BEGIN
  SELECT RAISE(ABORT, 'CRM export audit entries are append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_crm_export_audit_no_delete
BEFORE DELETE ON crm_export_audit BEGIN
  SELECT RAISE(ABORT, 'CRM export audit entries cannot be removed individually');
END;
