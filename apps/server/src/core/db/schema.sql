-- AgentLodge database schema
--
-- SQLite via node:sqlite, so no dependency. Every access goes through src/db/, which
-- means moving to Postgres later (DESIGN.md §4) is a matter of replacing that layer.
-- Times are ISO 8601 strings in UTC; booleans are 0/1.

pragma journal_mode = WAL;
pragma foreign_keys = ON;

/* ---------------- Users and authentication ---------------- */

create table if not exists users (
  id                  text primary key,
  email               text not null unique,
  username            text not null unique,
  password_hash       text not null,
  role                text not null default 'user',    -- user | admin
  status              text not null default 'active',  -- active | suspended
  invite_code_id      text,
  created_at          text not null,
  last_login_at       text,
  password_changed_at text
);

create table if not exists user_quotas (
  user_id     text primary key references users(id) on delete cascade,
  token_limit integer,                              -- null means no limit
  period      text    not null default 'monthly',   -- monthly | total
  hard_stop   integer not null default 1,           -- 0 warns without blocking
  updated_at  text    not null,
  updated_by  text,
  -- Which period a warning email has gone out for, so one period does not nag twice
  warned_period text,
  -- When an administrator zeroed it; counting starts at max(period start, reset_at)
  reset_at      text,
  -- Rolling periods: the window length in hours and this user's own start point
  period_hours  integer,
  cycle_start   text,
  -- 1 renews the window on expiry; 0 makes it a one-off that stops when used up or
  -- expired, until an administrator tops it up
  auto_renew    integer not null default 1,
  -- tokens limits by billable tokens; cost limits by money
  limit_kind    text not null default 'tokens',
  cost_limit_micro integer
);

create table if not exists invite_codes (
  id                 text primary key,
  code               text not null unique,
  email              text,        -- a targeted invite, the kind sent by email
  created_by         text,
  note               text,
  max_uses           integer not null default 1,
  used_count         integer not null default 0,
  expires_at         text,
  preset_role        text not null default 'user',
  preset_token_limit integer,
  disabled           integer not null default 0,
  created_at         text not null,
  sent_at            text        -- when the email actually went out
);
create index if not exists idx_invite_email on invite_codes(email);

create table if not exists auth_sessions (
  id                 text primary key,
  user_id            text not null references users(id) on delete cascade,
  refresh_token_hash text not null unique,
  device_name        text,
  platform           text,
  ip                 text,
  user_agent         text,
  rotated_from       text,
  expires_at         text not null,
  revoked_at         text,
  created_at         text not null,
  last_seen_at       text not null
);
create index if not exists idx_session_user on auth_sessions(user_id);
create index if not exists idx_session_rotated on auth_sessions(rotated_from);

create table if not exists password_resets (
  id         text primary key,
  user_id    text not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at text not null,
  used_at    text,
  created_at text not null
);
create index if not exists idx_reset_user on password_resets(user_id);

/*
 * Long-lived API keys — the credential for pointing your own claude / codex at this
 * service.
 *
 * They and runtime tokens (core/runtime-token.ts) are **two credentials into one
 * gateway**:
 *   runtime token  20 minutes, bound to (user, conversation, turn), used by our containers
 *   api key        long-lived, bound to the user only, used from the user's own machine
 * The gateway accepts both, and past that point quota, rate limiting, accounting and
 * traces are all the same.
 *
 * Only a sha256 is stored; the plaintext is returned once at creation and never again.
 * sha256 rather than bcrypt/argon2 because the key is 256 random bits — there is no weak
 * password to guess — and every request does an equality lookup on the hash, which a slow
 * hash would turn into a full table scan.
 */
create table if not exists api_keys (
  id           text primary key,
  user_id      text not null references users(id) on delete cascade,
  name         text not null,
  key_hash     text not null unique,
  -- For recognising a key in the list, e.g. al_3f9c2a1b. Not enough to reconstruct it.
  prefix       text not null,
  created_at   text not null,
  last_used_at text,
  revoked_at   text
);
create index if not exists idx_api_keys_user on api_keys(user_id);

/* ---------------- Conversations ---------------- */

create table if not exists conversations (
  id               text primary key,
  user_id          text not null references users(id) on delete cascade,
  agent            text not null,               -- claude | codex
  title            text not null,
  agent_session_id text,                        -- the CLI's own session/thread id
  model            text,
  effort           text,
  status           text not null default 'active',
  created_at       text not null,
  updated_at       text not null,
  last_message_at  text
);
create index if not exists idx_conv_user on conversations(user_id, updated_at desc);
create index if not exists idx_conv_user_agent on conversations(user_id, agent, updated_at desc);

create table if not exists messages (
  id              text primary key,
  conversation_id text not null references conversations(id) on delete cascade,
  seq             integer not null,
  role            text not null,               -- user | assistant
  blocks          text not null,               -- JSON: MessageBlock[]
  usage           text,                        -- JSON: TurnUsage
  error           text,
  aborted         integer not null default 0,
  created_at      text not null,
  unique (conversation_id, seq)
);
create index if not exists idx_msg_conv on messages(conversation_id, seq);

/* ---------------- Usage ---------------- */

-- One row per turn. Both the personal usage page and the quota gate read this table.
create table if not exists usage_records (
  id                    integer primary key autoincrement,
  user_id               text not null,
  conversation_id       text,
  turn_id               text,
  agent                 text not null,
  model                 text,
  effort                text,
  input_tokens          integer not null default 0,
  cache_read_tokens     integer not null default 0,
  cache_creation_tokens integer not null default 0,
  output_tokens         integer not null default 0,
  -- Billable tokens after weighting; this is what quota compares against
  billable_tokens       integer not null default 0,
  cost_usd              real    not null default 0,   -- as the CLI reported; usually 0 off-platform
  -- Cost from the price table, in micro-units. This is what money-based billing uses.
  cost_micro            integer not null default 0,
  duration_ms           integer,
  num_turns             integer,
  status                text not null,          -- completed | error | aborted
  created_at            text not null,
  day                   text not null,          -- YYYY-MM-DD, local time, for daily totals
  -- cli: the turn total the CLI reported. gateway: one row per call, and more accurate.
  source                text not null default 'cli',
  queue_wait_ms         integer,
  ttft_ms               integer,
  -- Non-empty means this came from a user's own CLI on an api key, not our containers
  api_key_id            text
);
create index if not exists idx_usage_user_day on usage_records(user_id, day);
create index if not exists idx_usage_user_created on usage_records(user_id, created_at desc);
create index if not exists idx_usage_conv on usage_records(conversation_id);

/* ---------------- Price table ---------------- */

-- Tokens to money. A price change inserts a row; past bills keep the price of their time.
-- Units are micro-units (1 unit = 1e6) per million tokens.
create table if not exists model_pricing (
  id                integer primary key autoincrement,
  -- A model name or prefix (deepseek-v4 matches deepseek-v4-pro); '*' is the catch-all
  model             text not null,
  currency          text not null default 'CNY',
  price_input       integer not null,   -- input that missed the cache
  price_cache_read  integer not null,   -- input that hit it, usually an order of magnitude cheaper
  price_cache_write integer not null,
  price_output      integer not null,
  effective_from    text not null,
  note              text,
  created_at        text not null
);
create index if not exists idx_pricing_model on model_pricing(model, effective_from desc);

/* ---------------- Upstream providers ---------------- */

-- Where the gateway forwards. Several rows, exactly one active at a time.
-- kind decides how the protocol is handled:
--   anthropic-native  speaks Messages natively; Claude to /anthropic, Codex to /responses,
--                     both relayed as-is
--   openai-chat       only /chat/completions (Ollama, LM Studio, vLLM, most third parties)
--                     so the gateway translates
--   mock              the built-in fake upstream: no network, no cost, for exercising the path
--   local-agent       a CLI on the host — text only, no tool calls — for testing
create table if not exists upstream_providers (
  id          text primary key,
  name        text not null,
  kind        text not null,
  base_url    text not null default '',
  api_key     text,                -- ciphertext (enc:v1:...), same key as settings
  -- For a key kept in a file: **a plaintext path, not a key**, read afresh before every
  -- use (see core/secret-file.ts). Mutually exclusive with api_key — setting one clears
  -- the other, so an old value cannot linger and make the two disagree.
  api_key_file text,
  active      integer not null default 0,
  note        text,
  -- The model list belongs to the provider, not to global settings: switching upstream
  -- switches the whole set of names, so the two belong together
  models        text not null default '',   -- comma-separated; empty uses the agent's own defaults
  default_model text not null default '',   -- used when a conversation names no model
  created_at  text not null,
  updated_at  text not null
);
create index if not exists idx_upstream_active on upstream_providers(active);

/* ---------------- System settings and audit ---------------- */

create table if not exists settings (
  key        text primary key,
  value      text not null,       -- plaintext JSON, or ciphertext (enc:v1:...)
  updated_at text not null,
  updated_by text
);

create table if not exists audit_logs (
  id          integer primary key autoincrement,
  actor_id    text,
  action      text not null,
  target_type text,
  target_id   text,
  detail      text,                -- JSON
  ip          text,
  created_at  text not null
);
create index if not exists idx_audit_created on audit_logs(created_at desc);
create index if not exists idx_audit_actor on audit_logs(actor_id, created_at desc);
