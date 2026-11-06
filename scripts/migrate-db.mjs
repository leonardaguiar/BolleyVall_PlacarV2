import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(here, '../db/migrations');
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('DATABASE_URL não está configurada. Adicione o segredo no Replit antes de migrar o banco.');
  process.exitCode = 1;
} else {
  await migrate();
}

async function migrate() {
  const client = new Client({ connectionString });
  try {
    await client.connect();
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())'
    );

    const files = (await readdir(migrationsDirectory))
      .filter(name => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
      .sort();

    for (const filename of files) {
      const sql = await readFile(path.join(migrationsDirectory, filename), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = await client.query(
        'SELECT checksum FROM schema_migrations WHERE filename = $1',
        [filename]
      );

      if (previous.rowCount) {
        if (previous.rows[0].checksum !== checksum) {
          throw new Error('A migração aplicada foi alterada: ' + filename);
        }
        console.log('Já aplicada:', filename);
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
          [filename, checksum]
        );
        await client.query('COMMIT');
        console.log('Aplicada:', filename);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.end();
  }
}
