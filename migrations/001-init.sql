-- drift-islands M1 数据库结构（PostgreSQL）
-- 依据 docs/M0-数据模型与接口定义.md §1：22 张表 + 索引。
-- 用法：psql -f migrations/001-init.sql，或由 docker compose 的 postgres 初始化目录自动执行。

BEGIN;

-- §1.1 users
CREATE TABLE IF NOT EXISTS users (
  id varchar PRIMARY KEY,
  display_name text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'normal',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- §1.3 ships
CREATE TABLE IF NOT EXISTS ships (
  id varchar PRIMARY KEY,
  captain_id varchar NULL,
  name text NOT NULL DEFAULT '无名船',
  durability integer NOT NULL DEFAULT 100,
  max_durability integer NOT NULL DEFAULT 100,
  speed double precision NOT NULL DEFAULT 10,
  cargo_capacity integer NOT NULL DEFAULT 20,
  weapon_power integer NOT NULL DEFAULT 0,
  defense_lv integer NOT NULL DEFAULT 0,
  weapon_lv integer NOT NULL DEFAULT 0,
  living_lv integer NOT NULL DEFAULT 0,
  research_lv integer NOT NULL DEFAULT 0,
  fuel double precision NOT NULL DEFAULT 20,
  x double precision NOT NULL DEFAULT 0,
  y double precision NOT NULL DEFAULT 0,
  hp integer NOT NULL DEFAULT 100,
  max_hp integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- §1.2 characters
CREATE TABLE IF NOT EXISTS characters (
  id varchar PRIMARY KEY,
  user_id varchar NOT NULL,
  name text NOT NULL UNIQUE,
  level integer NOT NULL DEFAULT 0,
  crystal_energy double precision NOT NULL DEFAULT 0,
  aptitude text NOT NULL DEFAULT 'body',
  hp integer NOT NULL DEFAULT 100,
  max_hp integer NOT NULL DEFAULT 100,
  stamina integer NOT NULL DEFAULT 100,
  max_stamina integer NOT NULL DEFAULT 100,
  speed integer NOT NULL DEFAULT 10,
  x double precision NOT NULL DEFAULT 0,
  y double precision NOT NULL DEFAULT 0,
  ship_id varchar NULL,
  island_id varchar NULL,
  team_id varchar NULL,
  protection_level integer NOT NULL DEFAULT 0,
  protection_active boolean NOT NULL DEFAULT false,
  fatigue double precision NOT NULL DEFAULT 0,
  fatigued_world_days integer NOT NULL DEFAULT 0,
  online_seconds_today integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'offline',
  title text NOT NULL DEFAULT 'sailor',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NULL
);

-- §1.11 teams
CREATE TABLE IF NOT EXISTS teams (
  id varchar PRIMARY KEY,
  name text NOT NULL,
  captain_id varchar NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- §1.10 skills
CREATE TABLE IF NOT EXISTS skills (
  id varchar PRIMARY KEY,
  character_id varchar NOT NULL,
  direction text NOT NULL,
  name text NOT NULL,
  level_unlocked integer NOT NULL,
  acquired_world_day integer NOT NULL,
  source_summary text NULL,
  payload jsonb NULL
);

-- §1.17 experience_logs
CREATE TABLE IF NOT EXISTS experience_logs (
  id varchar PRIMARY KEY,
  character_id varchar NOT NULL,
  world_day integer NOT NULL,
  world_minutes integer NOT NULL,
  event_type text NOT NULL,
  summary text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- §1.4 islands
CREATE TABLE IF NOT EXISTS islands (
  id varchar PRIMARY KEY,
  creator_user_id varchar NULL,
  name text NOT NULL,
  x double precision NOT NULL,
  y double precision NOT NULL,
  radius double precision NOT NULL DEFAULT 5,
  rules jsonb NULL,
  resource_direction text NULL,
  buildings jsonb NULL,
  defenses jsonb NULL,
  monster_config jsonb NULL,
  threat_budget double precision NOT NULL DEFAULT 60,
  threat_used double precision NOT NULL DEFAULT 0,
  max_monster_level integer NOT NULL DEFAULT 0,
  visit_count integer NOT NULL DEFAULT 0,
  resources_taken integer NOT NULL DEFAULT 0,
  owner_character_id varchar NULL,
  created_world_day integer NOT NULL DEFAULT 1,
  last_visit_world_day integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active',
  description text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- §1.5 island_points
CREATE TABLE IF NOT EXISTS island_points (
  id varchar PRIMARY KEY,
  island_id varchar NOT NULL,
  name text NOT NULL,
  description text NULL,
  monster_kind_ids jsonb NULL,
  monster_count integer NOT NULL DEFAULT 0
);

-- §1.6 monster_kinds
CREATE TABLE IF NOT EXISTS monster_kinds (
  id varchar PRIMARY KEY,
  name text NOT NULL,
  description text NULL,
  base_hp integer NOT NULL DEFAULT 10,
  base_speed integer NOT NULL DEFAULT 5,
  base_attack integer NOT NULL DEFAULT 3,
  skill_pool jsonb NULL,
  min_world_day integer NOT NULL DEFAULT 1,
  max_level integer NOT NULL DEFAULT 1
);

-- §1.7 monsters
CREATE TABLE IF NOT EXISTS monsters (
  id varchar PRIMARY KEY,
  kind_id varchar NULL,
  custom_name text NULL,
  custom_stats jsonb NULL,
  island_id varchar NULL,
  level integer NOT NULL DEFAULT 0,
  hp integer NOT NULL DEFAULT 10,
  max_hp integer NOT NULL DEFAULT 10,
  speed integer NOT NULL DEFAULT 5,
  attack integer NOT NULL DEFAULT 3,
  x double precision NOT NULL DEFAULT 0,
  y double precision NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'idle',
  faction_id varchar NULL,
  skills jsonb NULL,
  created_world_day integer NOT NULL DEFAULT 1
);

-- §1.8 items
CREATE TABLE IF NOT EXISTS items (
  id varchar PRIMARY KEY,
  name text NOT NULL,
  type text NOT NULL DEFAULT 'misc',
  tags jsonb NULL,
  quantity integer NOT NULL DEFAULT 1,
  condition text NULL,
  owner_type text NOT NULL DEFAULT 'character',
  owner_id varchar NOT NULL,
  x double precision NULL,
  y double precision NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- §1.9 crystals
CREATE TABLE IF NOT EXISTS crystals (
  id varchar PRIMARY KEY,
  level integer NOT NULL,
  energy_total real NOT NULL,
  energy_remaining real NOT NULL,
  holder_type text NOT NULL DEFAULT 'character',
  holder_id varchar NOT NULL,
  x real NULL,
  y real NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- §1.21 dead_drops
CREATE TABLE IF NOT EXISTS dead_drops (
  id varchar PRIMARY KEY,
  placer_character_id varchar NOT NULL,
  x real NOT NULL,
  y real NOT NULL,
  item_ids jsonb NULL,
  created_world_day integer NOT NULL,
  discovered_by varchar NULL
);

-- §1.12 channels
CREATE TABLE IF NOT EXISTS channels (
  id varchar PRIMARY KEY,
  type text NOT NULL,
  island_id varchar NULL,
  name text NOT NULL
);

-- §1.13 chat_messages
CREATE TABLE IF NOT EXISTS chat_messages (
  id varchar PRIMARY KEY,
  channel_id varchar NOT NULL,
  sender_character_id varchar NULL,
  content text NOT NULL,
  visibility text NOT NULL DEFAULT 'visible',
  moderation_category text NULL,
  kind text NOT NULL DEFAULT 'player',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- §1.18 moderation_records
CREATE TABLE IF NOT EXISTS moderation_records (
  id varchar PRIMARY KEY,
  user_id varchar NOT NULL,
  character_id varchar NULL,
  channel_id varchar NULL,
  message_id varchar NULL,
  category text NOT NULL,
  action text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by varchar NULL,
  reviewed_at timestamptz NULL
);

-- §1.14 world_state（单行）
CREATE TABLE IF NOT EXISTS world_state (
  id integer PRIMARY KEY,
  world_day integer NOT NULL DEFAULT 1,
  world_minutes integer NOT NULL DEFAULT 360,
  sea_radius_nm double precision NOT NULL DEFAULT 50,
  island_count integer NOT NULL DEFAULT 0,
  current_direction double precision NOT NULL DEFAULT 0,
  last_tick_at timestamptz NOT NULL DEFAULT now()
);

-- §1.15 world_events
CREATE TABLE IF NOT EXISTS world_events (
  id varchar PRIMARY KEY,
  trigger_type text NOT NULL,
  trigger_value text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NULL,
  status text NOT NULL DEFAULT 'pending',
  created_by varchar NULL,
  created_at timestamptz NULL
);

-- §1.16 combat_sessions
CREATE TABLE IF NOT EXISTS combat_sessions (
  id varchar PRIMARY KEY,
  channel_id varchar NOT NULL,
  island_id varchar NULL,
  state text NOT NULL DEFAULT 'active',
  round integer NOT NULL DEFAULT 0,
  round_deadline timestamptz NULL,
  participants jsonb NULL,
  actions jsonb NULL,
  log jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- §1.19 model_pool
CREATE TABLE IF NOT EXISTS model_pool (
  id varchar PRIMARY KEY,
  tier text NOT NULL,
  model_id text NOT NULL,
  priority integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  failure_count integer NOT NULL DEFAULT 0,
  last_failure_at timestamptz NULL
);

-- §1.20 resource_registry
CREATE TABLE IF NOT EXISTS resource_registry (
  id varchar PRIMARY KEY,
  canonical_name text NOT NULL UNIQUE,
  aliases jsonb NULL,
  category text NOT NULL,
  created_at timestamptz NULL
);

-- §1.22 ai_quotas
CREATE TABLE IF NOT EXISTS ai_quotas (
  user_id varchar NOT NULL,
  real_date date NOT NULL,
  calls_used integer NOT NULL DEFAULT 0,
  budget integer NOT NULL DEFAULT 200,
  degraded boolean NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, real_date)
);

-- §1.23 索引
CREATE INDEX IF NOT EXISTS idx_characters_xy ON characters (x, y);
CREATE INDEX IF NOT EXISTS idx_ships_xy ON ships (x, y);
CREATE INDEX IF NOT EXISTS idx_islands_xy ON islands (x, y);
CREATE INDEX IF NOT EXISTS idx_monsters_xy ON monsters (x, y);
CREATE INDEX IF NOT EXISTS idx_chat_messages_channel_created ON chat_messages (channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_experience_logs_character_day ON experience_logs (character_id, world_day);
CREATE INDEX IF NOT EXISTS idx_items_owner ON items (owner_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_crystals_holder ON crystals (holder_type, holder_id);
CREATE INDEX IF NOT EXISTS idx_moderation_user_created ON moderation_records (user_id, created_at);

COMMIT;
