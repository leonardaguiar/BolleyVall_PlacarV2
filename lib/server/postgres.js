import { Pool } from 'pg';

const globalForPostgres = globalThis;
const POOL_KEY = '__bolleyVallPostgresPool';

export function getPool() {
  if (typeof window !== 'undefined') {
    throw new Error('O PostgreSQL só pode ser acessado pelo servidor.');
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    const error = new Error('DATABASE_URL não está configurada no ambiente do servidor.');
    error.code = 'DATABASE_URL_MISSING';
    throw error;
  }

  if (!globalForPostgres[POOL_KEY]) {
    const pool = new Pool({
      connectionString,
      max: 4,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000
    });
    pool.on('error', error => {
      console.error('Erro inesperado no pool PostgreSQL:', error.code || 'sem código');
    });
    globalForPostgres[POOL_KEY] = pool;
  }
  return globalForPostgres[POOL_KEY];
}

export async function withTransaction(work) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}
