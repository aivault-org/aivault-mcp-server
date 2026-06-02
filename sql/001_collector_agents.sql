-- AIVault MCP Server: Agent Collector Registration Table
-- Run this in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS collector_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL CHECK (platform IN ('CHATGPT', 'CLAUDE', 'GEMINI', 'CODEX', 'CURSOR', 'OPENCODE', 'HERMES', 'OTHER')),
  agent_name TEXT NOT NULL,
  version TEXT,
  device TEXT,
  status TEXT NOT NULL DEFAULT 'online',
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_collector_agents_user ON collector_agents(user_id);
CREATE INDEX IF NOT EXISTS idx_collector_agents_status ON collector_agents(status);

ALTER TABLE collector_agents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can manage collector agents"
  ON collector_agents FOR ALL
  USING (true) WITH CHECK (true);
