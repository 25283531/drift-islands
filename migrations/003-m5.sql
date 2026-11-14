-- M5 内测：问题反馈

CREATE TABLE IF NOT EXISTS feedback (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  character_id text,
  category text NOT NULL DEFAULT 'other',
  content text NOT NULL,
  status text NOT NULL DEFAULT 'new',
  handled_by text,
  handled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback (status, created_at DESC);
