import { createHash } from 'node:crypto';
import { getPool } from './postgres.js';

const MAX_CREATIONS_PER_WINDOW = 5;

function requestClientAddress(request) {
  const forwardedFor = request.headers.get('x-forwarded-for');
  const forwardedAddress = forwardedFor?.split(',')[0]?.trim();
  const realAddress = request.headers.get('x-real-ip')?.trim();
  if (forwardedAddress || realAddress) return forwardedAddress || realAddress;

  const hostname = new URL(request.url).hostname;
  if (['localhost', '127.0.0.1', '::1'].includes(hostname)) return `local:${hostname}`;
  return 'unknown';
}

export async function consumeSessionCreationLimit(request) {
  const clientKey = createHash('sha256')
    .update(requestClientAddress(request).toLowerCase())
    .digest('hex');
  const result = await getPool().query(
    `INSERT INTO session_creation_limits (client_key, window_started_at, request_count)
     VALUES ($1, NOW(), 1)
     ON CONFLICT (client_key) DO UPDATE SET
       window_started_at = CASE
         WHEN session_creation_limits.window_started_at <= NOW() - INTERVAL '10 minutes' THEN NOW()
         ELSE session_creation_limits.window_started_at
       END,
       request_count = CASE
         WHEN session_creation_limits.window_started_at <= NOW() - INTERVAL '10 minutes' THEN 1
         ELSE LEAST(session_creation_limits.request_count + 1, $2)
       END
     RETURNING request_count,
       GREATEST(0, CEIL(EXTRACT(EPOCH FROM (
         window_started_at + INTERVAL '10 minutes' - NOW()
       ))))::INTEGER AS retry_after_seconds`,
    [clientKey, MAX_CREATIONS_PER_WINDOW + 1]
  );

  const row = result.rows[0];
  return {
    allowed: Number(row.request_count) <= MAX_CREATIONS_PER_WINDOW,
    retryAfterSeconds: Number(row.retry_after_seconds)
  };
}
