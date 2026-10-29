import { timed, queryFields } from './telemetry.js';
import pg from 'pg';

// App timestamps/counters are within JavaScript's safe integer range.
pg.types.setTypeParser(20, value => {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error('Database integer exceeds the supported range.');
  return number;
});
export function postgresQuery(sql) {
  let index = 0;
  return sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\?/g, match => (match === '?' ? `$${++index}` : match));
}
function adapter(rawQuery, close) {
  const query = (sql, args) => timed('db.query', () => rawQuery(sql, args), queryFields(sql));
  return {
    kind: 'postgres',
    async get(sql, ...args) {
      return (await query(postgresQuery(sql), args)).rows[0];
    },
    async all(sql, ...args) {
      return (await query(postgresQuery(sql), args)).rows;
    },
    async run(sql, ...args) {
      return { changes: (await query(postgresQuery(sql), args)).rowCount };
    },
    close
  };
}
export async function openPostgresStore(connectionString, { max = 5 } = {}) {
  if (!connectionString) throw new Error('DATABASE_URL is required for Postgres.');
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must be a PostgreSQL URL.');
  if (url.hostname.endsWith('.neon.tech')) url.searchParams.set('sslmode', 'verify-full');
  // Neon-generated URLs require TLS. Never disable certificate verification.
  const pool = new pg.Pool({
    connectionString: url.toString(),
    enableChannelBinding: true,
    max,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
    query_timeout: 30000,
    application_name: 'gmail-cleanup'
  });
  pool.on('error', () => console.error('Postgres pool encountered a connection error.'));
  try {
    await pool.query('SELECT 1');
  } catch {
    await pool.end();
    throw new Error('Postgres connection failed. Check DATABASE_URL and network access.');
  }
  const poolQuery = async (sql, args) => {
    const client = await timed('db.pool_wait', () => pool.connect(), {
      waiting: pool.waitingCount,
      idle: pool.idleCount,
      total: pool.totalCount
    });
    try {
      return await client.query(sql, args);
    } finally {
      client.release();
    }
  };
  const store = adapter(poolQuery, () => pool.end());
  store.transaction = async fn => {
    const client = await timed('db.pool_wait', () => pool.connect());
    const control = sql => timed('db.transaction_control', () => client.query(sql), { verb: sql });
    try {
      await control('BEGIN');
      const transaction = adapter(client.query.bind(client), async () => {});
      const result = await fn(transaction);
      await control('COMMIT');
      return result;
    } catch (error) {
      await control('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };
  return store;
}
