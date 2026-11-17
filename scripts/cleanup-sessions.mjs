import { Client } from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('DATABASE_URL não está configurada no ambiente.');
  process.exitCode = 1;
} else {
  await cleanup();
}

async function cleanup() {
  const client = new Client({ connectionString });
  try {
    await client.connect();
    await client.query('BEGIN');

    const expiredLimits = await client.query(
      `DELETE FROM session_creation_limits
        WHERE window_started_at < NOW() - INTERVAL '10 minutes'`
    );
    const expiredSessions = await client.query(
      `DELETE FROM sessions s
        WHERE GREATEST(
          s.updated_at,
          COALESCE(
            (SELECT l.heartbeat_at FROM control_lease l WHERE l.session_id = s.id),
            s.updated_at
          )
        ) < NOW() - INTERVAL '15 days'
        RETURNING s.id`
    );

    await client.query('COMMIT');
    console.log(`Salas apagadas por inatividade: ${expiredSessions.rowCount}.`);
    console.log(`Contadores antigos removidos: ${expiredLimits.rowCount}.`);
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('Falha na limpeza automática:', error.code || 'erro interno');
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
