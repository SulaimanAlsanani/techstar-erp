-- Cloudflare D1 schema for public quote requests.
-- This migration does not activate data collection by itself.
CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  client_request_id TEXT NOT NULL UNIQUE,
  reference TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  business TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  industry TEXT NOT NULL DEFAULT '',
  package_id TEXT NOT NULL DEFAULT '',
  solution_id TEXT NOT NULL DEFAULT '',
  branches INTEGER NOT NULL CHECK (branches BETWEEN 1 AND 10000),
  pos_count INTEGER NOT NULL CHECK (pos_count BETWEEN 0 AND 10000),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'new'
);
CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status, created_at DESC);
