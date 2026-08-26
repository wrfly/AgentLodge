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
  user_id      text primary key references users(id) on delete cascade,
  -- tokens limits by billable tokens; cost limits by money in micro-units
  limit_kind   text not null default 'tokens',
  /*
   * Three ceilings, all in the unit named above, all null-means-unlimited.
   *
   * The windows they apply to are the platform's, not each user's: one 5-hour window, one
   * week, one month, beginning and ending at the same instants for everybody. A window
   * measured from a user's own first message would tell somebody who started at four that
   * they have until nine, when the pool empties at seven.
   */
  window_limit integer,
  week_limit   integer,
  month_limit  integer,
  hard_stop    integer not null default 1,
  /*
   * A top-up raises one window's ceiling, and expires with that window.
   *
   * It used to be a rolling allowance with its own start point, which is exactly the
   * per-user window the model above exists to remove. Attached to a window instead, it
   * keeps what it was for — letting one person through for now — without giving them
   * boundaries of their own.
   */
  boost_scope  text,                    -- window | week | month
  boost_amount integer,
  boost_until  text,                    -- the window's end at the moment it was granted
  -- When an administrator zeroed it; counting starts at max(window start, reset_at)
  reset_at     text,
  -- Which window a warning email has gone out for, so one window does not nag twice
  warned_period text,
  updated_at   text not null,
  updated_by   text
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
  last_message_at  text,
  -- A few lines saying what this conversation was about; see app/recap.ts
  summary          text,
  summary_at       text,
  -- How many messages the summary covers, so a conversation that has moved on is spotted
  summary_upto     integer,
  -- The user named this one themselves, so nothing else may rename it
  title_custom     integer not null default 0,
  -- When a model named it. Null means never, and that is the whole condition for
  -- naming it: once, on the first completed turn, and never again.
  title_at         text
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
  -- Which upstream served it. Two providers can offer the same model at different prices,
  -- so the bill cannot be reconstructed from the model name alone.
  provider_id           text,
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
  -- Which upstream this price is for. Null means any: the same model served by two
  -- upstreams can cost two different amounts, and a row without a provider is the
  -- fallback for whichever of them has no price of its own.
  provider_id       text,
  currency          text not null default 'CNY',
  price_input       integer not null,   -- input that missed the cache
  price_cache_read  integer not null,   -- input that hit it, usually an order of magnitude cheaper
  price_cache_write integer not null,
  price_output      integer not null,
  effective_from    text not null,
  note              text,
  created_at        text not null
);
create index if not exists idx_pricing_model on model_pricing(model, provider_id, effective_from desc);

/* ---------------- Upstream providers and models ---------------- */

-- Where the gateway can forward. Several rows, all usable at once: which one serves a
-- request is decided by the model that request asks for (see the models table below).
-- kind decides how the protocol is handled:
--   anthropic-native  speaks Messages natively; Claude to /anthropic, Codex to /responses,
--                     both relayed as-is
--   openai-chat       only /chat/completions (Ollama, LM Studio, vLLM, most third parties)
--                     so the gateway translates
--   mock              built-in, no network
--   local-agent       a CLI on the host, text only
create table if not exists upstream_providers (
  id          text primary key,
  name        text not null,
  kind        text not null,
  base_url    text not null default '',
  -- The credential this provider uses, by id: **a name, not a value**. What is behind it
  -- lives in the credential manager (credential-manager/), which hands the gateway an
  -- access token per request. Nothing usable upstream is stored here.
  credential_id text,
  note        text,
  created_at  text not null,
  updated_at  text not null
);

-- A model a user can pick, and the upstream that serves it.
--
-- The name is what everything else keys on: the picker in the interface, the model field
-- in a request, the pricing table, a usage row. One name may have several rows — the same
-- model offered by two upstreams, at two prices — and `priority` decides which is used
-- (lowest first). The others are what a failover would reach for.
--
-- upstream_name covers the case where the name upstream is not the name here: an endpoint
-- that calls it `deepseek-chat` while users pick `deepseek-v4-pro`. Empty means they match.
create table if not exists models (
  id            text primary key,
  name          text not null,
  provider_id   text not null references upstream_providers(id) on delete cascade,
  upstream_name text not null default '',
  enabled       integer not null default 1,
  priority      integer not null default 0,
  note          text,
  created_at    text not null,
  updated_at    text not null,
  unique(name, provider_id)
);
create index if not exists idx_models_name on models(name, priority);

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

-- One picture of how a person works, written from their conversation summaries.
-- Kept because it costs a request to make; regenerated when they ask for it.
create table if not exists user_portraits (
  user_id       text primary key references users(id) on delete cascade,
  text          text not null,
  -- JSON: lines the model thinks are worth remembering, for the user to accept or ignore
  candidates    text,
  -- How many conversation summaries went into it
  conversations integer not null default 0,
  created_at    text not null
);
