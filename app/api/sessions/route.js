import { createSession } from '../../../lib/server/sessions.js';
import { getShareOrigin } from '../../../lib/server/share-origin.js';
import { consumeSessionCreationLimit } from '../../../lib/server/session-limits.js';

export const runtime = 'nodejs';
const MAX_REQUEST_BODY_BYTES = 2.25 * 1024 * 1024;

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store' }
  });
}

function matchesRequestOrigin(request, origin) {
  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }

  const requestUrl = new URL(request.url);
  const host = request.headers.get('host') || requestUrl.host;
  return originUrl.protocol === requestUrl.protocol && originUrl.host.toLowerCase() === host.toLowerCase();
}

class RequestBodyTooLargeError extends Error {}

async function readJsonBody(request) {
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BODY_BYTES) {
    throw new RequestBodyTooLargeError();
  }

  if (!request.body) throw new SyntaxError('Corpo JSON inválido.');
  const reader = request.body.getReader();
  const chunks = [];
  let byteLength = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new RequestBodyTooLargeError();
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks, byteLength)));
}

export async function POST(request) {
  const origin = request.headers.get('origin');
  if (origin && !matchesRequestOrigin(request, origin)) {
    return json({ error: 'Origem da requisição não permitida.' }, 403);
  }

  let input;
  try {
    input = await readJsonBody(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return json({ error: 'O corpo da requisição excede o limite de 2,25 MiB.' }, 413);
    }
    return json({ error: 'Corpo JSON inválido.' }, 400);
  }

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return json({ error: 'Informe o plano e o estado da sala.' }, 400);
  }
  if (Object.keys(input).some(key => !['plan', 'state'].includes(key))) {
    return json({ error: 'A requisição contém campos não permitidos.' }, 400);
  }

  const deviceId = request.headers.get('x-device-id') || '';

  try {
    const rateLimit = await consumeSessionCreationLimit(request);
    if (!rateLimit.allowed) {
      return Response.json(
        { error: 'Limite de cinco criações de sala por IP a cada 10 minutos atingido. Tente novamente mais tarde.' },
        {
          status: 429,
          headers: {
            'Cache-Control': 'no-store',
            'Retry-After': String(rateLimit.retryAfterSeconds)
          }
        }
      );
    }
    const session = await createSession({ plan: input.plan, state: input.state, deviceId });
    return json({ ...session, shareOrigin: getShareOrigin(request) }, 201);
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
