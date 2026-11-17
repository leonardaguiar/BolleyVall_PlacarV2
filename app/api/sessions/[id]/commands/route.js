import { authorizeSessionAccess, SessionNotFoundError } from '../../../../../lib/server/sessions.js';
import { applySessionCommand, SessionCommandError } from '../../../../../lib/server/session-commands.js';

export const runtime = 'nodejs';

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

function bearerToken(request) {
  return /^Bearer ([A-Za-z0-9_-]{40,50})$/.exec(request.headers.get('authorization') || '')?.[1] || null;
}

const DATA_FIELDS = {
  'score.adjust': ['side', 'delta'],
  'teams.swapSides': [],
  'timer.toggle': [],
  'match.finish': [],
  'match.correct': [],
  'queue.skip': ['teamId'],
  'queue.togglePlayed': ['teamId'],
  'command.undo': []
};

export async function POST(request, context) {
  const { id } = await context.params;
  try {
    const token = bearerToken(request);
    if (!token) return json({ error: 'Acesso inválido ou expirado.' }, 401);
    const access = await authorizeSessionAccess(id, token);
    if (!access) return json({ error: 'Acesso inválido ou expirado.' }, 401);
    let input;
    try { input = await request.json(); } catch { return json({ error: 'Corpo JSON inválido.' }, 400); }
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !['expectedRevision', 'commandId', 'type', 'data'].includes(key))) {
      return json({ error: 'Informe um comando válido.' }, 400);
    }
    const data = input.data ?? {};
    const fields = Object.hasOwn(DATA_FIELDS, input.type) ? DATA_FIELDS[input.type] : null;
    if (!fields || !data || typeof data !== 'object' || Array.isArray(data)
        || Object.keys(data).some(key => !fields.includes(key))) {
      return json({ error: 'Os dados do comando não são válidos.' }, 400);
    }
    const result = await applySessionCommand({
      id,
      accessId: access.id,
      deviceId: request.headers.get('x-device-id') || '',
      expectedRevision: input.expectedRevision,
      commandId: input.commandId,
      type: input.type,
      data
    });
    return json(result);
  } catch (error) {
    if (error instanceof TypeError) return json({ error: error.message }, 400);
    if (error instanceof SessionNotFoundError) return json({ error: error.message }, 404);
    if (error instanceof SessionCommandError) {
      return json({ error: error.message, ...(error.currentRevision === undefined ? {} : { currentRevision: error.currentRevision }) }, error.status);
    }
    if (error?.code === 'DATABASE_URL_MISSING') return json({ error: 'Banco de dados não configurado no servidor.' }, 503);
    console.error('Falha ao executar comando da sala:', error?.code || 'erro interno');
    return json({ error: 'Não foi possível executar o comando da sala.' }, 500);
  }
}
