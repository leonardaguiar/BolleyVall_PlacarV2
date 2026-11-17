import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getPool, withTransaction } from './postgres.js';
import { SessionNotFoundError } from './sessions.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateInput(id, role) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new TypeError('Identificador de sala inválido.');
  if (!['viewer', 'operator'].includes(role)) throw new TypeError('Papel de acesso inválido.');
}

export async function issueSessionAccess({ id, role, actorAccessId }) {
  validateInput(id, role);
  const accessId = randomUUID();
  const accessToken = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(accessToken).digest('hex');
  return withTransaction(async client => {
    const session = await client.query('SELECT id, revision FROM sessions WHERE id = $1 FOR UPDATE', [id]);
    if (!session.rowCount) throw new SessionNotFoundError(id);
    await client.query(
      'UPDATE session_access SET revoked_at = NOW() WHERE session_id = $1 AND role = $2 AND revoked_at IS NULL',
      [id, role]
    );
    await client.query(
      'INSERT INTO session_access (id, session_id, token_hash, role) VALUES ($1, $2, $3, $4)',
      [accessId, id, tokenHash, role]
    );
    await client.query(
      'INSERT INTO session_events (id, session_id, revision, event_type, payload, actor_access_id) VALUES ($1, $2, $3, $4, $5::jsonb, $6)',
      [randomUUID(), id, Number(session.rows[0].revision), 'access.issued', JSON.stringify({ role }), actorAccessId]
    );
    return { role, accessToken };
  });
}

export async function revokeSessionAccess({ id, role, actorAccessId }) {
  validateInput(id, role);
  return withTransaction(async client => {
    const session = await client.query('SELECT revision FROM sessions WHERE id = $1 FOR UPDATE', [id]);
    if (!session.rowCount) throw new SessionNotFoundError(id);
    const revoked = await client.query(
      'UPDATE session_access SET revoked_at = NOW() WHERE session_id = $1 AND role = $2 AND revoked_at IS NULL RETURNING id',
      [id, role]
    );
    if (revoked.rowCount) {
      await client.query(
        'INSERT INTO session_events (id, session_id, revision, event_type, payload, actor_access_id) VALUES ($1, $2, $3, $4, $5::jsonb, $6)',
        [randomUUID(), id, Number(session.rows[0].revision), 'access.revoked', JSON.stringify({ role }), actorAccessId]
      );
    }
    return { role, revoked: revoked.rowCount > 0 };
  });
}
