CREATE TABLE IF NOT EXISTS public.session_creation_limits (
  client_key TEXT PRIMARY KEY,
  window_started_at TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count BETWEEN 1 AND 6)
);

CREATE INDEX IF NOT EXISTS idx_session_creation_limits_window
  ON public.session_creation_limits (window_started_at);

ALTER TABLE public.session_creation_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.session_creation_limits
  FROM PUBLIC, anon, authenticated;
