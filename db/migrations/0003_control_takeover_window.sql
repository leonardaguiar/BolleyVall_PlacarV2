ALTER TABLE public.control_lease RENAME COLUMN expires_at TO takeover_at;

UPDATE public.control_lease
   SET takeover_at = heartbeat_at + INTERVAL '1 minute';
