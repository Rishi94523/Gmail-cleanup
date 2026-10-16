import pg from 'pg';

// App timestamps/counters are within JavaScript's safe integer range.
pg.types.setTypeParser(20, value => {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error('Database integer exceeds the supported range.');
  return number;
});
export function postgresQuery(sql) {
  let index = 0;
  return sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\?/g, match => match === '?' ? `$${++index}` : match);
}
function adapter(query, close) {
  return {
    kind: 'postgres',
    async get(sql, ...args) { return (await query(postgresQuery(sql), args)).rows[0]; },
    async all(sql, ...args) { return (await query(postgresQuery(sql), args)).rows; },
    async run(sql, ...args) { return { changes: (await query(postgresQuery(sql), args)).rowCount }; },
    close
  };
}
export async function openPostgresStore(connectionString, { max = 5 } = {}) {
  if (!connectionString) throw new Error('DATABASE_URL is required for Postgres.');
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must be a PostgreSQL URL.');
  if (url.hostname.endsWith('.neon.tech')) url.searchParams.set('sslmode', 'verify-full');
  // Neon-generated URLs require TLS. Never disable certificate verification.
  const pool = new pg.Pool({ connectionString: url.toString(), enableChannelBinding: true, max, idleTimeoutMillis: 30000, connectionTimeoutMillis: 15000, query_timeout: 30000, application_name: 'gmail-cleanup' });
  pool.on('error', () => console.error('Postgres pool encountered a connection error.'));
  try { await pool.query('SELECT 1'); } catch { await pool.end(); throw new Error('Postgres connection failed. Check DATABASE_URL and network access.'); }
  const store = adapter(pool.query.bind(pool), () => pool.end());
  store.transaction = async fn => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const transaction = adapter(client.query.bind(client), async () => {});
      const result = await fn(transaction);
      await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  };
  return store;
}
