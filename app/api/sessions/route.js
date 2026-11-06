import { createSession } from '../../../lib/server/sessions.js';

export const runtime = 'nodejs';

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store' }
  });
}

export async function POST(request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) {
    return json({ error: 'Origem da requisição não permitida.' }, 403);
  }

  let input;
  try {
    input = await request.json();
  } catch {
    return json({ error: 'Corpo JSON inválido.' }, 400);
  }

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return json({ error: 'Informe o plano e o estado da sala.' }, 400);
  }
  if (Object.keys(input).some(key => !['plan', 'state'].includes(key))) {
    return json({ error: 'A requisição contém campos não permitidos.' }, 400);
  }

  try {
    const session = await createSession({ plan: input.plan, state: input.state });
    return json(session, 201);
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      return json({ error: error.message }, 400);
    }
    if (error?.code === 'DATABASE_URL_MISSING') {
      return json({ error: 'Banco de dados não configurado no servidor.' }, 503);
    }
    console.error('Falha ao criar sala:', error?.code || 'erro interno');
    return json({ error: 'Não foi possível criar a sala.' }, 500);
  }
}
