import {
  authorizeSessionAccess,
  getSession,
  SessionNotFoundError,
  SessionNotActiveError
} from '../../../../../lib/server/sessions.js';
import { issueSessionAccess, revokeSessionAccess } from '../../../../../lib/server/session-access.js';
import { getShareOrigin } from '../../../../../lib/server/share-origin.js';

export const runtime = 'nodejs';

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

function bearerToken(request) {
  return /^Bearer ([A-Za-z0-9_-]{40,50})$/.exec(request.headers.get('authorization') || '')?.[1] || null;
}

async function organizer(request, id) {
  const token = bearerToken(request);
  if (!token) return null;
  try {
    const access = await authorizeSessionAccess(id, token);
    return access?.role === 'organizer' ? access : null;
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

async function requireActiveSession(id) {
  const session = await getSession(id);
  if (!session) throw new SessionNotFoundError(id);
  if (session.status !== 'active') throw new SessionNotActiveError();
}

export async function POST(request, context) {
  const { id } = await context.params;
  try {
    const access = await organizer(request, id);
    if (!access) return json({ error: 'Acesso de organizador inválido ou expirado.' }, 401);
    await requireActiveSession(id);
    let input;
    try { input = await request.json(); } catch { return json({ error: 'Corpo JSON inválido.' }, 400); }
    if (!input || Object.keys(input).some(key => key !== 'role')) return json({ error: 'Informe um papel válido.' }, 400);
    const issued = await issueSessionAccess({ id, role: input.role, actorAccessId: access.id });
    return json({ ...issued, url: `${getShareOrigin(request)}/s/${id}#${issued.accessToken}` }, 201);
  } catch (error) {
    if (error instanceof TypeError) return json({ error: error.message }, 400);
    if (error instanceof SessionNotFoundError) return json({ error: error.message }, 404);
    if (error instanceof SessionNotActiveError) return json({ error: error.message }, 409);
    if (error?.code === 'DATABASE_URL_MISSING') return json({ error: 'Banco de dados não configurado no servidor.' }, 503);
    console.error('Falha ao emitir acesso:', error?.code || 'erro interno');
    return json({ error: 'Não foi possível emitir o acesso.' }, 500);
  }
}

export async function DELETE(request, context) {
  const { id } = await context.params;
  try {
    const access = await organizer(request, id);
    if (!access) return json({ error: 'Acesso de organizador inválido ou expirado.' }, 401);
    await requireActiveSession(id);
    let input;
    try { input = await request.json(); } catch { return json({ error: 'Corpo JSON inválido.' }, 400); }
    if (!input || Object.keys(input).some(key => key !== 'role')) return json({ error: 'Informe um papel válido.' }, 400);
    return json(await revokeSessionAccess({ id, role: input.role, actorAccessId: access.id }));
  } catch (error) {
    if (error instanceof TypeError) return json({ error: error.message }, 400);
    if (error instanceof SessionNotFoundError) return json({ error: error.message }, 404);
    if (error instanceof SessionNotActiveError) return json({ error: error.message }, 409);
    if (error?.code === 'DATABASE_URL_MISSING') return json({ error: 'Banco de dados não configurado no servidor.' }, 503);
    console.error('Falha ao revogar acesso:', error?.code || 'erro interno');
    return json({ error: 'Não foi possível revogar o acesso.' }, 500);
  }
}
