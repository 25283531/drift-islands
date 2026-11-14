-- M4 激励与治理：岛屿评价、创作者激励台账、举报

CREATE TABLE IF NOT EXISTS island_ratings (
  id text PRIMARY KEY,
  island_id text NOT NULL,
  user_id text NOT NULL,
  score integer NOT NULL,
  comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT island_ratings_unique UNIQUE (island_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_island_ratings_island ON island_ratings (island_id);

CREATE TABLE IF NOT EXISTS creator_rewards (
  id text PRIMARY KEY,
  island_id text NOT NULL,
  creator_user_id text NOT NULL,
  period_day integer NOT NULL,
  score double precision NOT NULL,
  amount integer NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'granted',
  settled_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT creator_rewards_unique UNIQUE (island_id, period_day)
);
CREATE INDEX IF NOT EXISTS idx_creator_rewards_creator ON creator_rewards (creator_user_id);

CREATE TABLE IF NOT EXISTS reports (
  id text PRIMARY KEY,
  reporter_user_id text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  category text NOT NULL,
  detail text,
  status text NOT NULL DEFAULT 'pending',
  action text,
  handled_by text,
  handled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports (status, created_at DESC);
