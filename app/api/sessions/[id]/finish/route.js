import { authorizeSessionAccess, finishSession, SessionNotFoundError, SessionControlRequiredError } from '../../../../../lib/server/sessions.js';

export const runtime = 'nodejs';

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request, context) {
  const { id } = await context.params;
  const match = /^Bearer ([A-Za-z0-9_-]{40,50})$/.exec(request.headers.get('authorization') || '');
  if (!match) return json({ error: 'Acesso inválido ou expirado.' }, 401);
  try {
    const access = await authorizeSessionAccess(id, match[1]);
    if (!access) return json({ error: 'Acesso inválido ou expirado.' }, 401);
    if (access.role !== 'organizer') return json({ error: 'Somente o organizador pode encerrar a competição.' }, 403);
    return json(await finishSession({ id, actorAccessId: access.id, deviceId: request.headers.get('x-device-id') || '' }));
  } catch (error) {
    if (error instanceof TypeError) return json({ error: error.message }, 400);
    if (error instanceof SessionNotFoundError) return json({ error: error.message }, 404);
    if (error instanceof SessionControlRequiredError) return json({ error: error.message }, 409);
    if (error?.code === 'DATABASE_URL_MISSING') return json({ error: 'Banco de dados não configurado no servidor.' }, 503);
    console.error('Falha ao encerrar competição:', error?.code || 'erro interno');
    return json({ error: 'Não foi possível encerrar a competição.' }, 500);
  }
}
