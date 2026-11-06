import {
  authorizeSessionAccess,
  getSession,
  SessionNotFoundError,
  SessionRevisionConflictError,
  updateSession
} from '../../../../lib/server/sessions.js';

export const runtime = 'nodejs';

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store' }
  });
}

function bearerToken(request) {
  const match = /^Bearer ([A-Za-z0-9_-]{40,50})$/.exec(request.headers.get('authorization') || '');
  return match?.[1] || null;
}

async function authorize(request, id) {
  const token = bearerToken(request);
  if (!token) return null;
  try {
    return await authorizeSessionAccess(id, token);
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

export async function GET(request, context) {
  const { id } = await context.params;
  try {
    const access = await authorize(request, id);
    if (!access) return json({ error: 'Acesso inválido ou expirado.' }, 401);

    const session = await getSession(id);
    if (!session) return json({ error: 'Sala não encontrada.' }, 404);
    return json(session);
  } catch (error) {
    if (error?.code === 'DATABASE_URL_MISSING') {
      return json({ error: 'Banco de dados não configurado no servidor.' }, 503);
    }
    console.error('Falha ao carregar sala:', error?.code || 'erro interno');
    return json({ error: 'Não foi possível carregar a sala.' }, 500);
  }
}

export async function PATCH(request, context) {
  const { id } = await context.params;
  try {
    const access = await authorize(request, id);
    if (!access) return json({ error: 'Acesso inválido ou expirado.' }, 401);
    if (access.role !== 'organizer') {
      return json({ error: 'Este acesso não pode alterar a sala.' }, 403);
    }

    let input;
    try {
      input = await request.json();
    } catch {
      return json({ error: 'Corpo JSON inválido.' }, 400);
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return json({ error: 'Informe os dados que serão atualizados.' }, 400);
    }
    if (Object.keys(input).some(key => !['expectedRevision', 'plan', 'state'].includes(key))) {
      return json({ error: 'A requisição contém campos não permitidos.' }, 400);
    }

    const session = await updateSession({
      id,
      expectedRevision: input.expectedRevision,
      plan: input.plan,
      state: input.state,
      actorAccessId: access.id
    });
    return json(session);
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      return json({ error: error.message }, 400);
    }
    if (error instanceof SessionNotFoundError) {
      return json({ error: error.message }, 404);
    }
    if (error instanceof SessionRevisionConflictError) {
      return json({ error: error.message, currentRevision: error.currentRevision }, 409);
    }
    if (error?.code === 'DATABASE_URL_MISSING') {
      return json({ error: 'Banco de dados não configurado no servidor.' }, 503);
    }
    console.error('Falha ao atualizar sala:', error?.code || 'erro interno');
    return json({ error: 'Não foi possível atualizar a sala.' }, 500);
  }
}
