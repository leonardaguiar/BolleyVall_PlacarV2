import { getPool, withTransaction } from './postgres.js';
import { SessionNotFoundError } from './sessions.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PENDING_PREFIX = 'pending:';

export class ControlLeaseConflictError extends Error {
  constructor(message = 'O controle da sala está em uso por outro aparelho.') {
    super(message);
    this.name = 'ControlLeaseConflictError';
    this.status = 409;
  }
}

export class ControlLeasePermissionError extends Error {
  constructor(message = 'Este acesso não pode controlar a sala.') {
    super(message);
    this.name = 'ControlLeasePermissionError';
    this.status = 403;
  }
}

function validate(id, accessId, deviceId, allowMissingDevice = false) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new TypeError('Identificador de sala inválido.');
  if (typeof accessId !== 'string' || !UUID_RE.test(accessId)) throw new TypeError('Acesso inválido.');
  if (allowMissingDevice && (deviceId === undefined || deviceId === null || deviceId === '')) return;
  if (typeof deviceId !== 'string' || !UUID_RE.test(deviceId)) throw new TypeError('Identificador deste aparelho inválido.');
}

async function lockActiveAccess(client, id, accessId) {
  const session = await client.query('SELECT id, status FROM sessions WHERE id = $1 FOR UPDATE', [id]);
  if (!session.rowCount) throw new SessionNotFoundError(id);
  if (session.rows[0].status !== 'active') throw new ControlLeaseConflictError('A competição foi encerrada; a sala está somente para visualização.');
  const access = await client.query(
    `SELECT id, role FROM session_access
      WHERE id = $1 AND session_id = $2 AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())`,
    [accessId, id]
  );
  if (!access.rowCount) throw new ControlLeasePermissionError('Este link foi revogado ou expirou.');
  return access.rows[0];
}

async function activeLease(client, id) {
  const result = await client.query(
    `SELECT l.access_id, l.device_id, l.heartbeat_at, l.takeover_at,
            l.takeover_at <= NOW() AS takeover_available, a.role
       FROM control_lease l
       JOIN session_access a ON a.id = l.access_id AND a.session_id = l.session_id
      WHERE l.session_id = $1
        AND a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at > NOW())
      FOR UPDATE OF l`,
    [id]
  );
  return result.rows[0] || null;
}

export async function getControlState({ id, accessId, deviceId }) {
  validate(id, accessId, deviceId, true);
  const result = await getPool().query(
    `SELECT s.status,
            a.role AS requester_role,
            l.access_id AS holder_access_id, l.device_id AS holder_device_id,
            l.takeover_at, l.heartbeat_at, holder.role AS holder_role,
            COALESCE(l.takeover_at <= NOW(), FALSE) AS takeover_available,
            EXISTS (SELECT 1 FROM session_access op WHERE op.session_id = s.id
              AND op.role = 'operator' AND op.revoked_at IS NULL
              AND (op.expires_at IS NULL OR op.expires_at > NOW())) AS operator_available
       FROM sessions s
       JOIN session_access a ON a.session_id = s.id AND a.id = $2
      LEFT JOIN control_lease l ON l.session_id = s.id
        AND EXISTS (SELECT 1 FROM session_access current_holder WHERE current_holder.id = l.access_id
          AND current_holder.session_id = s.id AND current_holder.revoked_at IS NULL
          AND (current_holder.expires_at IS NULL OR current_holder.expires_at > NOW()))
       LEFT JOIN session_access holder ON holder.id = l.access_id AND holder.session_id = s.id
      WHERE s.id = $1 AND a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at > NOW())`,
    [id, accessId]
  );
  if (!result.rowCount) return null;
  const row = result.rows[0];
  const pending = row.holder_device_id?.startsWith(PENDING_PREFIX) || false;
  return {
    status: row.status,
    role: row.requester_role,
    held: !!row.holder_access_id,
    holderRole: row.holder_role || null,
    takeoverAt: row.takeover_at || null,
    takeoverAvailable: !!row.takeover_available,
    lastHeartbeatAt: row.heartbeat_at || null,
    ownedByThisDevice: row.holder_access_id === accessId && row.holder_device_id === deviceId,
    reservedForThisAccess: pending && row.holder_access_id === accessId,
    awaitingOperator: pending,
    operatorAvailable: row.operator_available
  };
}

export async function claimControl({ id, accessId, deviceId }) {
  validate(id, accessId, deviceId);
  return withTransaction(async client => {
    const access = await lockActiveAccess(client, id, accessId);
    if (!['organizer', 'operator'].includes(access.role)) throw new ControlLeasePermissionError('O papel de visualizador não pode assumir o controle.');
    const lease = await activeLease(client, id);
    if (lease) {
      if (lease.access_id === accessId && lease.device_id === deviceId) {
        const refreshed = await client.query(
          `UPDATE control_lease SET heartbeat_at = NOW(), takeover_at = NOW() + INTERVAL '1 minute'
            WHERE session_id = $1 RETURNING takeover_at`, [id]);
        return { action: 'renewed', takeoverAt: refreshed.rows[0].takeover_at };
      }
      if (lease.access_id === accessId && lease.role === 'operator' && lease.device_id === `${PENDING_PREFIX}${accessId}`) {
        const activated = await client.query(
          `UPDATE control_lease SET device_id = $2, acquired_at = NOW(), heartbeat_at = NOW(), takeover_at = NOW() + INTERVAL '1 minute'
            WHERE session_id = $1 RETURNING takeover_at`, [id, deviceId]);
        return { action: 'claimed', takeoverAt: activated.rows[0].takeover_at };
      }
      if (lease.takeover_available) {
        const taken = await client.query(
          `UPDATE control_lease SET access_id = $2, device_id = $3, acquired_at = NOW(), heartbeat_at = NOW(), takeover_at = NOW() + INTERVAL '1 minute'
            WHERE session_id = $1 RETURNING takeover_at`, [id, accessId, deviceId]);
        return { action: 'claimed', takeover: true, takeoverAt: taken.rows[0].takeover_at };
      }
      throw new ControlLeaseConflictError();
    }
    const created = await client.query(
      `INSERT INTO control_lease (session_id, access_id, device_id, acquired_at, heartbeat_at, takeover_at)
       VALUES ($1, $2, $3, NOW(), NOW(), NOW() + INTERVAL '1 minute')
       ON CONFLICT (session_id) DO UPDATE SET access_id = EXCLUDED.access_id, device_id = EXCLUDED.device_id,
         acquired_at = NOW(), heartbeat_at = NOW(), takeover_at = EXCLUDED.takeover_at
       RETURNING takeover_at`, [id, accessId, deviceId]);
    return { action: 'claimed', takeoverAt: created.rows[0].takeover_at };
  });
}

export async function renewControl({ id, accessId, deviceId }) {
  validate(id, accessId, deviceId);
  return withTransaction(async client => {
    const access = await lockActiveAccess(client, id, accessId);
    if (!['organizer', 'operator'].includes(access.role)) throw new ControlLeasePermissionError('O papel de visualizador não pode renovar o controle.');
    const lease = await activeLease(client, id);
    if (!lease || lease.access_id !== accessId || lease.device_id !== deviceId) throw new ControlLeaseConflictError('Este aparelho não detém o controle ativo.');
    const refreshed = await client.query(
      `UPDATE control_lease SET heartbeat_at = NOW(), takeover_at = NOW() + INTERVAL '1 minute' WHERE session_id = $1 RETURNING takeover_at`, [id]);
    return { action: 'renewed', takeoverAt: refreshed.rows[0].takeover_at };
  });
}

export async function releaseControl({ id, accessId, deviceId }) {
  validate(id, accessId, deviceId);
  return withTransaction(async client => {
    const access = await lockActiveAccess(client, id, accessId);
    if (!['organizer', 'operator'].includes(access.role)) throw new ControlLeasePermissionError('O papel de visualizador não pode liberar o controle.');
    const lease = await activeLease(client, id);
    if (!lease) return { action: 'released' };
    const ownsLease = lease.access_id === accessId && lease.device_id === deviceId;
    if (!ownsLease && access.role !== 'organizer') throw new ControlLeaseConflictError('Somente quem controla a sala ou o organizador pode liberar este controle.');
    await client.query('DELETE FROM control_lease WHERE session_id = $1', [id]);
    return { action: 'released' };
  });
}

export async function recoverControl({ id, accessId, deviceId }) {
  validate(id, accessId, deviceId);
  return withTransaction(async client => {
    const access = await lockActiveAccess(client, id, accessId);
    if (access.role !== 'organizer') throw new ControlLeasePermissionError('Somente o organizador pode recuperar o controle.');
    const result = await client.query(
      `INSERT INTO control_lease (session_id, access_id, device_id, acquired_at, heartbeat_at, takeover_at)
       VALUES ($1, $2, $3, NOW(), NOW(), NOW() + INTERVAL '1 minute')
       ON CONFLICT (session_id) DO UPDATE SET access_id = EXCLUDED.access_id, device_id = EXCLUDED.device_id,
         acquired_at = NOW(), heartbeat_at = NOW(), takeover_at = EXCLUDED.takeover_at
       RETURNING takeover_at`, [id, accessId, deviceId]);
    return { action: 'recovered', takeoverAt: result.rows[0].takeover_at };
  });
}

export async function transferControlToOperator({ id, accessId }) {
  if (typeof id !== 'string' || !UUID_RE.test(id) || typeof accessId !== 'string' || !UUID_RE.test(accessId)) throw new TypeError('Acesso inválido.');
  return withTransaction(async client => {
    const organizer = await lockActiveAccess(client, id, accessId);
    if (organizer.role !== 'organizer') throw new ControlLeasePermissionError('Somente o organizador pode transferir o controle.');
    const operator = await client.query(
      `SELECT id FROM session_access WHERE session_id = $1 AND role = 'operator' AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY created_at DESC LIMIT 1`, [id]);
    if (!operator.rowCount) throw new ControlLeaseConflictError('Emita um link de operador antes de transferir o controle.');
    await client.query(
      `INSERT INTO control_lease (session_id, access_id, device_id, acquired_at, heartbeat_at, takeover_at)
       VALUES ($1, $2, $3, NOW(), NOW(), NOW() + INTERVAL '1 minute')
       ON CONFLICT (session_id) DO UPDATE SET access_id = EXCLUDED.access_id, device_id = EXCLUDED.device_id,
         acquired_at = NOW(), heartbeat_at = NOW(), takeover_at = EXCLUDED.takeover_at`,
      [id, operator.rows[0].id, `${PENDING_PREFIX}${operator.rows[0].id}`]);
    return { action: 'transferred', targetRole: 'operator' };
  });
}
