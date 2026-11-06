import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getPool, withTransaction } from './postgres.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_JSON_BYTES = 1024 * 1024;

export class SessionNotFoundError extends Error {
  constructor(id) {
    super('Sala não encontrada.');
    this.name = 'SessionNotFoundError';
    this.sessionId = id;
    this.status = 404;
  }
}

export class SessionRevisionConflictError extends Error {
  constructor(currentRevision) {
    super('A sala foi atualizada por outro aparelho.');
    this.name = 'SessionRevisionConflictError';
    this.currentRevision = currentRevision;
    this.status = 409;
  }
}

function validateUuid(id) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    throw new TypeError('Identificador de sala inválido.');
  }
}

function validateJsonObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(label + ' deve ser um objeto JSON.');
  }
  const serialized = JSON.stringify(value);
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > MAX_JSON_BYTES) {
    throw new RangeError(label + ' excede o limite permitido.');
  }
  return serialized;
}

function validatePlan(plan) {
  if (typeof plan.unit !== 'string' || !Array.isArray(plan.fases) || plan.fases.length < 1) {
    throw new TypeError('Plano do sorteio inválido.');
  }
  return validateJsonObject(plan, 'Plano do sorteio');
}

function validateState(state) {
  if (!Number.isInteger(state.faseAtual) || !Array.isArray(state.fases) || !Array.isArray(state.historico)) {
    throw new TypeError('Estado da sala inválido.');
  }
  return validateJsonObject(state, 'Estado da sala');
}

export async function createSession({ plan, state }) {
  const planJson = validatePlan(plan);
  const stateJson = validateState(state);
  const id = randomUUID();
  const accessId = randomUUID();
  const accessToken = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(accessToken).digest('hex');

  return withTransaction(async client => {
    const created = await client.query(
      'INSERT INTO sessions (id, plan_json) VALUES ($1, $2::jsonb) RETURNING id, status, revision, created_at, updated_at',
      [id, planJson]
    );
    await client.query(
      'INSERT INTO session_state (session_id, state_json) VALUES ($1, $2::jsonb)',
      [id, stateJson]
    );
    await client.query(
      'INSERT INTO session_access (id, session_id, token_hash, role) VALUES ($1, $2, $3, $4)',
      [accessId, id, tokenHash, 'organizer']
    );
    await client.query(
      'INSERT INTO session_events (id, session_id, revision, event_type, payload, actor_access_id) VALUES ($1, $2, 0, $3, $4::jsonb, $5)',
      [randomUUID(), id, 'session.created', JSON.stringify({ source: 'local' }), accessId]
    );
    const row = created.rows[0];
    return {
      id: row.id,
      status: row.status,
      revision: Number(row.revision),
      plan,
      state,
      accessToken,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  });
}

export async function authorizeSessionAccess(id, accessToken) {
  validateUuid(id);
  if (typeof accessToken !== 'string' || !/^[A-Za-z0-9_-]{40,50}$/.test(accessToken)) {
    return null;
  }
  const tokenHash = createHash('sha256').update(accessToken).digest('hex');
  const result = await getPool().query(
    `SELECT id, role
       FROM session_access
      WHERE session_id = $1
        AND token_hash = $2
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())`,
    [id, tokenHash]
  );
  return result.rows[0] || null;
}

export async function getSession(id) {
  validateUuid(id);
  const result = await getPool().query(
    'SELECT s.id, s.status, s.plan_json, s.revision, s.created_at, s.updated_at, st.state_json, st.updated_at AS state_updated_at FROM sessions s JOIN session_state st ON st.session_id = s.id WHERE s.id = $1',
    [id]
  );
  if (!result.rowCount) return null;
  const row = result.rows[0];
  return {
    id: row.id,
    status: row.status,
    revision: Number(row.revision),
    plan: row.plan_json,
    state: row.state_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stateUpdatedAt: row.state_updated_at
  };
}

export async function updateSession({ id, expectedRevision, plan, state, actorAccessId }) {
  validateUuid(id);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new TypeError('Revisão esperada inválida.');
  }
  const planJson = plan === undefined ? null : validatePlan(plan);
  const stateJson = state === undefined ? null : validateState(state);
  if (planJson === null && stateJson === null) {
    throw new TypeError('Informe o plano ou o estado que será atualizado.');
  }

  return withTransaction(async client => {
    const currentResult = await client.query(
      'SELECT revision FROM sessions WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (!currentResult.rowCount) throw new SessionNotFoundError(id);

    const currentRevision = Number(currentResult.rows[0].revision);
    if (currentRevision !== expectedRevision) {
      throw new SessionRevisionConflictError(currentRevision);
    }

    const nextRevision = currentRevision + 1;
    const updated = await client.query(
      'UPDATE sessions SET plan_json = COALESCE($2::jsonb, plan_json), revision = $3, updated_at = NOW() WHERE id = $1 RETURNING id, status, revision, created_at, updated_at, plan_json',
      [id, planJson, nextRevision]
    );
    if (stateJson !== null) {
      await client.query(
        'UPDATE session_state SET state_json = $2::jsonb, updated_at = NOW() WHERE session_id = $1',
        [id, stateJson]
      );
    }

    const eventType = planJson !== null && stateJson !== null
      ? 'session.updated'
      : planJson !== null ? 'session.plan.updated' : 'session.state.updated';
    await client.query(
      'INSERT INTO session_events (id, session_id, revision, event_type, payload, actor_access_id) VALUES ($1, $2, $3, $4, $5::jsonb, $6)',
      [randomUUID(), id, nextRevision, eventType, JSON.stringify({ planChanged: planJson !== null, stateChanged: stateJson !== null }), actorAccessId || null]
    );

    const row = updated.rows[0];
    return {
      id: row.id,
      status: row.status,
      revision: Number(row.revision),
      plan: row.plan_json,
      state: state === undefined ? undefined : JSON.parse(stateJson),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  });
}
