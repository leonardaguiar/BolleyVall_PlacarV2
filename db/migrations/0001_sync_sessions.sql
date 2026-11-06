CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'finished', 'archived')),
  plan_json JSONB NOT NULL,
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS session_state (
  session_id UUID PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  state_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS session_access (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'operator', 'organizer')),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, session_id)
);

CREATE TABLE IF NOT EXISTS matches (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  phase_index INTEGER NOT NULL CHECK (phase_index >= 0),
  match_number INTEGER NOT NULL CHECK (match_number >= 1),
  team_a_json JSONB NOT NULL,
  team_b_json JSONB NOT NULL,
  score_a INTEGER CHECK (score_a IS NULL OR score_a >= 0),
  score_b INTEGER CHECK (score_b IS NULL OR score_b >= 0),
  winner_side SMALLINT CHECK (winner_side IS NULL OR winner_side IN (1, 2)),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, phase_index, match_number)
);

CREATE TABLE IF NOT EXISTS control_lease (
  session_id UUID PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  access_id UUID NOT NULL,
  device_id TEXT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (access_id, session_id)
    REFERENCES session_access(id, session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS session_events (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  revision BIGINT NOT NULL CHECK (revision >= 0),
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_access_id UUID REFERENCES session_access(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_status_updated
  ON sessions (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_matches_session_history
  ON matches (session_id, phase_index, match_number);
CREATE INDEX IF NOT EXISTS idx_events_session_revision
  ON session_events (session_id, revision DESC);
CREATE INDEX IF NOT EXISTS idx_access_session_role
  ON session_access (session_id, role);
