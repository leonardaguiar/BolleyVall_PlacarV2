import { randomUUID } from 'node:crypto';
import { withTransaction } from './postgres.js';
import { SessionNotFoundError } from './sessions.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATOR_COMMANDS = new Set(['score.adjust', 'teams.swapSides', 'timer.toggle', 'match.finish', 'queue.skip', 'queue.togglePlayed']);
const ORGANIZER_COMMANDS = new Set([...OPERATOR_COMMANDS, 'match.correct', 'command.undo']);

export class SessionCommandError extends Error {
  constructor(message, status = 400, details = {}) {
    super(message);
    this.name = 'SessionCommandError';
    this.status = status;
    Object.assign(this, details);
  }
}

function validateEnvelope({ id, accessId, deviceId, expectedRevision, commandId, type }) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new TypeError('Identificador de sala inválido.');
  if (typeof accessId !== 'string' || !UUID_RE.test(accessId)) throw new TypeError('Acesso inválido.');
  if (typeof deviceId !== 'string' || !UUID_RE.test(deviceId)) throw new TypeError('Identificador deste aparelho inválido.');
  if (typeof commandId !== 'string' || !UUID_RE.test(commandId)) throw new TypeError('Identificador do comando inválido.');
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new TypeError('Revisão esperada inválida.');
  if (typeof type !== 'string') throw new TypeError('Comando inválido.');
}

function elapsedSeconds(score) {
  const base = Number.isInteger(score.seconds) ? score.seconds : 0;
  if (!score.running || !score.startedAt) return base;
  const started = Date.parse(score.startedAt);
  if (!Number.isFinite(started)) return base;
  return base + Math.max(0, Math.floor((Date.now() - started) / 1000));
}

function scoreOf(state) {
  if (!state.placar || typeof state.placar !== 'object') state.placar = {};
  if (!Number.isInteger(state.placar.a) || state.placar.a < 0) state.placar.a = 0;
  if (!Number.isInteger(state.placar.b) || state.placar.b < 0) state.placar.b = 0;
  if (!Number.isInteger(state.placar.seconds) || state.placar.seconds < 0) state.placar.seconds = 0;
  return state.placar;
}

function currentPhase(plan, state) {
  const index = state.faseAtual;
  const config = plan.fases?.[index];
  const progress = state.fases?.[index];
  if (!config || !progress || !Array.isArray(progress.quadra) || progress.quadra.length !== 2) {
    throw new SessionCommandError('Não há partida ativa nesta fase.', 409);
  }
  return { index, config, progress };
}

function assertOngoingMatch(plan, state) {
  const phase = currentPhase(plan, state);
  if (phase.config.modo === 'jogo' && phase.progress.vencedor !== null && phase.progress.vencedor !== undefined) {
    throw new SessionCommandError('Esta rodada já foi encerrada.', 409);
  }
  return phase;
}

function nextQueuedId(phase) {
  if (!phase.fila?.length) return null;
  if (phase.fila.every(item => item.jogou)) phase.fila.forEach(item => { item.jogou = false; });
  const index = phase.fila.findIndex(item => !item.jogou);
  return phase.fila.splice(index < 0 ? 0 : index, 1)[0]?.id ?? null;
}

function advanceQueue(phase, winnerId, loserId) {
  phase.fila ||= [];
  phase.sequencia ||= {};
  phase.fila.push({ id: loserId, jogou: true });
  if (Number(phase.sequencia[winnerId] || 1) >= 2) {
    phase.fila.push({ id: winnerId, jogou: true });
    const first = nextQueuedId(phase);
    const second = nextQueuedId(phase);
    if (first !== null && second !== null) {
      phase.quadra = [first, second];
      phase.sequencia[first] = 1;
      phase.sequencia[second] = 1;
    }
  } else {
    const challenger = nextQueuedId(phase);
    if (challenger !== null) {
      phase.sequencia[winnerId] = Number(phase.sequencia[winnerId] || 1) + 1;
      phase.sequencia[challenger] = 1;
      phase.quadra = [winnerId, challenger];
    }
  }
}

function finishMatch(plan, state, winnerSideOverride = null) {
  const { index, config, progress } = currentPhase(plan, state);
  if (config.modo === 'jogo' && progress.vencedor !== null && progress.vencedor !== undefined) {
    throw new SessionCommandError('Esta rodada já foi encerrada.', 409);
  }
  const score = scoreOf(state);
  if (winnerSideOverride === null && score.a === score.b) {
    throw new SessionCommandError('O placar está empatado. Some pontos para definir um vencedor.', 422);
  }
  const winnerSide = winnerSideOverride ?? (score.a > score.b ? 1 : 2);
  const winnerId = progress.quadra[winnerSide - 1];
  const loserId = progress.quadra[winnerSide === 1 ? 1 : 0];
  const teamA = config.times?.[progress.quadra[0]];
  const teamB = config.times?.[progress.quadra[1]];
  if (!Array.isArray(teamA) || !Array.isArray(teamB)) throw new SessionCommandError('Os times da partida não são válidos.', 409);
  const winner = config.times[winnerId];
  const loser = config.times[loserId];
  const matchNumber = Number(progress.jogos || 0) + 1;
  const match = {
    matchId: randomUUID(),
    phaseIndex: index,
    titulo: config.titulo,
    numero: matchNumber,
    vencedor: winner.join(' + '),
    perdedor: loser.join(' + '),
    vencedores: winner,
    perdedores: loser,
    teams: [teamA, teamB],
    scoreA: score.a,
    scoreB: score.b,
    winnerSide
  };
  progress.jogos = matchNumber;
  state.historico ||= [];
  state.historico.push(match);

  if (config.modo === 'jogo') {
    progress.vencedor = winnerId;
    if (index < plan.fases.length - 1) state.faseAtual += 1;
  } else {
    advanceQueue(progress, winnerId, loserId);
  }
  state.placar = { ...score, a: 0, b: 0, seconds: 0, running: false, startedAt: null };
  return match;
}

function applySimpleCommand(type, data, plan, state) {
  switch (type) {
    case 'teams.swapSides': {
      const { progress } = assertOngoingMatch(plan, state);
      [progress.quadra[0], progress.quadra[1]] = [progress.quadra[1], progress.quadra[0]];
      const score = scoreOf(state);
      [score.a, score.b] = [score.b, score.a];
      const colors = {
        colorA: score.colorA || '#2F6FED',
        colorADim: score.colorADim || '#1E4CA8',
        colorB: score.colorB || '#E5484D',
        colorBDim: score.colorBDim || '#A32A2E'
      };
      score.colorA = colors.colorB;
      score.colorADim = colors.colorBDim;
      score.colorB = colors.colorA;
      score.colorBDim = colors.colorADim;
      [score.nameA, score.nameB] = [score.nameB, score.nameA];
      return { state, match: null };
    }
    case 'score.adjust': {
      if (!['a', 'b'].includes(data.side) || ![-1, 1].includes(data.delta)) throw new TypeError('Informe o lado e o ajuste de um ponto.');
      assertOngoingMatch(plan, state);
      const score = scoreOf(state);
      score[data.side] = Math.max(0, score[data.side] + data.delta);
      if (!score.running) {
        score.running = true;
        score.startedAt = new Date().toISOString();
      }
      return { state, match: null };
    }
    case 'timer.toggle': {
      assertOngoingMatch(plan, state);
      const score = scoreOf(state);
      if (score.running) {
        score.seconds = elapsedSeconds(score);
        score.running = false;
        score.startedAt = null;
      } else {
        score.running = true;
        score.startedAt = new Date().toISOString();
      }
      return { state, match: null };
    }
    case 'match.finish': {
      const match = finishMatch(plan, state);
      return { state, match };
    }
    case 'queue.skip':
    case 'queue.togglePlayed': {
      if (!Number.isInteger(data.teamId) || data.teamId < 0) throw new TypeError('Time inválido para a fila.');
      const { config, progress } = assertOngoingMatch(plan, state);
      if (config.modo !== 'fila') throw new SessionCommandError('Esta fase não usa fila.', 409);
      const item = progress.fila?.find(row => row.id === data.teamId);
      if (!item) throw new SessionCommandError('O time não está na fila atual.', 409);
      if (type === 'queue.togglePlayed') item.jogou = !item.jogou;
      else {
        progress.fila.splice(progress.fila.indexOf(item), 1);
        item.jogou = false;
        progress.fila.push(item);
      }
      return { state, match: null };
    }
    default: throw new TypeError('Comando desconhecido.');
  }
}

async function persistState(client, id, state, revision) {
  await client.query('UPDATE session_state SET state_json = $2::jsonb, updated_at = NOW() WHERE session_id = $1', [id, JSON.stringify(state)]);
  await client.query('UPDATE sessions SET revision = $2, updated_at = NOW() WHERE id = $1', [id, revision]);
}

async function replaceMatchRows(client, id, state) {
  const matches = (state.historico || []).filter(match => match.matchId && Array.isArray(match.teams) && match.teams.length === 2);
  const ids = matches.map(match => match.matchId);
  if (ids.length) {
    await client.query('DELETE FROM matches WHERE session_id = $1 AND NOT (id = ANY($2::uuid[]))', [id, ids]);
  } else {
    await client.query('DELETE FROM matches WHERE session_id = $1', [id]);
  }
  for (const match of matches) {
    await client.query(
      `INSERT INTO matches (id, session_id, phase_index, match_number, team_a_json, team_b_json, score_a, score_b, winner_side, ended_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, NOW())
       ON CONFLICT (id) DO UPDATE SET phase_index = EXCLUDED.phase_index, match_number = EXCLUDED.match_number,
         team_a_json = EXCLUDED.team_a_json, team_b_json = EXCLUDED.team_b_json, score_a = EXCLUDED.score_a,
         score_b = EXCLUDED.score_b, winner_side = EXCLUDED.winner_side, ended_at = NOW()`,
      [match.matchId, id, match.phaseIndex, match.numero, JSON.stringify(match.teams[0]), JSON.stringify(match.teams[1]), match.scoreA, match.scoreB, match.winnerSide]
    );
  }
}

export async function applySessionCommand({ id, accessId, deviceId, expectedRevision, commandId, type, data = {} }) {
  validateEnvelope({ id, accessId, deviceId, expectedRevision, commandId, type });
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new TypeError('Dados do comando inválidos.');

  return withTransaction(async client => {
    const sessionResult = await client.query(
      `SELECT s.status, s.revision, s.plan_json, st.state_json
         FROM sessions s JOIN session_state st ON st.session_id = s.id
        WHERE s.id = $1 FOR UPDATE OF s, st`, [id]);
    if (!sessionResult.rowCount) throw new SessionNotFoundError(id);
    const row = sessionResult.rows[0];
    if (row.status !== 'active') throw new SessionCommandError('A competição foi encerrada; esta sala está somente para visualização.', 409);
    const accessResult = await client.query(
      `SELECT role FROM session_access WHERE id = $1 AND session_id = $2 AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())`, [accessId, id]);
    if (!accessResult.rowCount) throw new SessionCommandError('Este acesso foi revogado ou expirou.', 401);
    const role = accessResult.rows[0].role;
    const allowed = role === 'organizer' ? ORGANIZER_COMMANDS : role === 'operator' ? OPERATOR_COMMANDS : new Set();
    if (!allowed.has(type)) throw new SessionCommandError('Este papel não pode executar esta ação.', 403);
    const lease = await client.query(
      `SELECT 1 FROM control_lease l JOIN session_access a ON a.id = l.access_id AND a.session_id = l.session_id
        WHERE l.session_id = $1 AND l.access_id = $2 AND l.device_id = $3
          AND a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at > NOW())`, [id, accessId, deviceId]);
    if (!lease.rowCount) throw new SessionCommandError('Este aparelho não detém o controle ativo da sala.', 409);

    const prior = await client.query(
      `SELECT revision, payload FROM session_events WHERE session_id = $1 AND payload->>'commandId' = $2 LIMIT 1`, [id, commandId]);
    if (prior.rowCount) {
      return {
        id, status: row.status, revision: Number(row.revision), plan: row.plan_json, state: row.state_json,
        role, duplicate: true, commandId
      };
    }
    const revision = Number(row.revision);
    if (revision !== expectedRevision) {
      throw new SessionCommandError('A sala recebeu outra ação; o estado foi atualizado.', 409, { currentRevision: revision });
    }

    const beforeState = row.state_json;
    let state = structuredClone(beforeState);
    let match = null;
    let undoOf = null;
    let eventType = ({
      'score.adjust': 'score_adjusted',
      'teams.swapSides': 'team_sides_swapped',
      'timer.toggle': 'timer_toggled',
      'match.finish': 'match_finished',
      'queue.skip': 'queue_skipped',
      'queue.togglePlayed': 'queue_play_status_toggled'
    })[type] || type.replaceAll('.', '_');
    if (type === 'match.correct') {
      const latest = await client.query(
        `SELECT event_type, payload FROM session_events WHERE session_id = $1 AND payload ? 'commandId'
          ORDER BY revision DESC LIMIT 1`, [id]);
      const lastMatch = state.historico?.at(-1);
      if (!latest.rowCount || latest.rows[0].event_type !== 'match_finished'
          || !lastMatch?.matchId || latest.rows[0].payload.matchId !== lastMatch.matchId
          || !latest.rows[0].payload.beforeState) {
        throw new SessionCommandError('Só é possível corrigir o último resultado antes de registrar outra ação.', 409);
      }
      const wantedSide = latest.rows[0].payload.winnerSide === 1 ? 2 : 1;
      state = structuredClone(latest.rows[0].payload.beforeState);
      match = finishMatch(row.plan_json, state, wantedSide);
      eventType = 'match_corrected';
    } else if (type === 'command.undo') {
      const latest = await client.query(
        `SELECT action.payload FROM session_events action
          WHERE action.session_id = $1 AND action.payload ? 'commandId'
            AND action.payload->>'commandType' <> 'command.undo'
            AND NOT EXISTS (
              SELECT 1 FROM session_events undone
               WHERE undone.session_id = action.session_id AND undone.event_type = 'command_undone'
                 AND undone.payload->>'undoOf' = action.payload->>'commandId'
            )
          ORDER BY action.revision DESC LIMIT 1`, [id]);
      if (!latest.rowCount || !latest.rows[0].payload.beforeState) {
        throw new SessionCommandError('Não há uma ação recente disponível para desfazer.', 409);
      }
      undoOf = latest.rows[0].payload.commandId;
      state = structuredClone(latest.rows[0].payload.beforeState);
      eventType = 'command_undone';
    } else {
      const result = applySimpleCommand(type, data, row.plan_json, state);
      state = result.state;
      match = result.match;
    }

    const nextRevision = revision + 1;
    await persistState(client, id, state, nextRevision);
    if (['match.finish', 'match.correct', 'command.undo'].includes(type)) await replaceMatchRows(client, id, state);
    await client.query(
      `INSERT INTO session_events (id, session_id, revision, event_type, payload, actor_access_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [randomUUID(), id, nextRevision, eventType, JSON.stringify({ commandId, commandType: type, data, matchId: match?.matchId || null, winnerSide: match?.winnerSide || null, undoOf, beforeState }), accessId]
    );
    return { id, status: row.status, revision: nextRevision, plan: row.plan_json, state, role, commandId };
  });
}
