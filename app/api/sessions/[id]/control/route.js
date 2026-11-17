import { authorizeSessionAccess, SessionNotFoundError } from '../../../../../lib/server/sessions.js';
import {
  claimControl,
  getControlState,
  releaseControl,
  renewControl,
  recoverControl,
  transferControlToOperator,
  ControlLeaseConflictError,
  ControlLeasePermissionError
} from '../../../../../lib/server/control-lease.js';

export const runtime = 'nodejs';

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

function bearerToken(request) {
  return /^Bearer ([A-Za-z0-9_-]{40,50})$/.exec(request.headers.get('authorization') || '')?.[1] || null;
}

function deviceId(request) { return request.headers.get('x-device-id') || ''; }

async function accessFor(request, id) {
  const token = bearerToken(request);
  return token ? authorizeSessionAccess(id, token) : null;
}

function handleError(error) {
  if (error instanceof TypeError) return json({ error: error.message }, 400);
  if (error instanceof SessionNotFoundError) return json({ error: error.message }, 404);
  if (error instanceof ControlLeaseConflictError || error instanceof ControlLeasePermissionError) return json({ error: error.message }, error.status);
  if (error?.code === 'DATABASE_URL_MISSING') return json({ error: 'Banco de dados não configurado no servidor.' }, 503);
  console.error('Falha ao processar controle da sala:', error?.code || 'erro interno');
  return json({ error: 'Não foi possível processar o controle da sala.' }, 500);
}

export async function GET(request, context) {
  const { id } = await context.params;
  try {
    const access = await accessFor(request, id);
    if (!access) return json({ error: 'Acesso inválido ou expirado.' }, 401);
    const state = await getControlState({ id, accessId: access.id, deviceId: deviceId(request) });
    if (!state) return json({ error: 'Sala ou acesso não encontrado.' }, 404);
    return json(state);
  } catch (error) { return handleError(error); }
}

export async function POST(request, context) {
  const { id } = await context.params;
  try {
    const access = await accessFor(request, id);
    if (!access) return json({ error: 'Acesso inválido ou expirado.' }, 401);
    let input;
    try { input = await request.json(); } catch { return json({ error: 'Corpo JSON inválido.' }, 400); }
    if (!input || Object.keys(input).some(key => key !== 'action') || typeof input.action !== 'string') return json({ error: 'Informe uma ação de controle válida.' }, 400);
    const args = { id, accessId: access.id, deviceId: deviceId(request) };
    let result;
    switch (input.action) {
      case 'claim': result = await claimControl(args); break;
      case 'renew': result = await renewControl(args); break;
      case 'release': result = await releaseControl(args); break;
      case 'recover': result = await recoverControl(args); break;
      case 'transfer': result = await transferControlToOperator({ id, accessId: access.id }); break;
      default: return json({ error: 'Ação de controle desconhecida.' }, 400);
    }
    return json(result);
  } catch (error) { return handleError(error); }
}
