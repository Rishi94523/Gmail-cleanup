import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { openStore } from './store.js';
import { encryption, randomToken, hash } from './security.js';
import { DEFAULT_RULES } from './rules.js';
import { InboxService } from './service.js';
import { jsonFetch } from './gmail.js';

export function createApp(options = {}) {
  const config = { port: Number(process.env.PORT || 3000), host: process.env.HOST || '127.0.0.1', appUrl: process.env.APP_URL || 'http://localhost:3000', clientId: process.env.GOOGLE_CLIENT_ID || '', clientSecret: process.env.GOOGLE_CLIENT_SECRET || '', encryptionKey: process.env.TOKEN_ENCRYPTION_KEY || '', aiKey: process.env.AI_API_KEY || '', aiModel: process.env.AI_MODEL || 'google/gemini-2.5-flash', ...options.config };
  const origin = new URL(config.appUrl).origin;
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname) && !origin.startsWith('https://')) throw new Error('APP_URL must use HTTPS outside localhost.');
  const store = options.store || openStore(options.dataDir);
  const crypto = config.encryptionKey ? encryption(config.encryptionKey) : null;
  const ready = Boolean(crypto && config.clientId && config.clientSecret);
  const service = crypto ? new InboxService(store, crypto, config, options.clientFactory) : null;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
  const assets = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']]]);
  function cookie(value, maxAge = 2592000) { return `inboxclean_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${origin.startsWith('https:') ? '; Secure' : ''}`; }
  function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }
  function redirect(res, to) { res.writeHead(302, { Location: to }); res.end(); }
  function newSession(res, accountId = null) {
    const token = randomToken(); const session = { id: hash(token), account_id: accountId, csrf: randomToken(), expires: Date.now() + 2592000000 };
    store.run('INSERT INTO sessions(id,account_id,csrf,expires) VALUES(?,?,?,?)', session.id, session.account_id, session.csrf, session.expires);
    res.setHeader('Set-Cookie', cookie(token)); return session;
  }
  async function body(req) {
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 65536) throw new Error('Request too large.'); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new Error('Invalid JSON.'); }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    let url; let session;
    try {
      if (req.headers.host !== new URL(origin).host) return json(res, 403, { error: `Open the app at ${origin}.` });
      url = new URL(req.url, origin);
      const token = req.headers.cookie?.split(';').map(p => p.trim()).find(p => p.startsWith('inboxclean_session='))?.slice(19);
      session = token ? store.get('SELECT * FROM sessions WHERE id=? AND expires>?', hash(token), Date.now()) : null;
      if (url.pathname === '/api/status' && req.method === 'GET') {
        if (!session) session = newSession(res);
        const account = session.account_id ? store.get('SELECT id,email,rules,last_day,last_error FROM accounts WHERE id=?', session.account_id) : null;
        return json(res, 200, { csrf: session.csrf, configured: ready, aiConfigured: Boolean(config.aiKey), connected: Boolean(account), email: account?.email || null, rules: account ? JSON.parse(account.rules) : DEFAULT_RULES, lastDay: account?.last_day || null, lastError: account?.last_error || null, totals: account ? { cleaned: store.get("SELECT coalesce(sum(changed),0) AS total FROM runs WHERE account_id=? AND status!='undone'", account.id).total, requested: store.get("SELECT count(*) AS total FROM subscriptions WHERE account_id=? AND status='requested'", account.id).total } : null, setupMissing: [!config.clientId && 'GOOGLE_CLIENT_ID', !config.clientSecret && 'GOOGLE_CLIENT_SECRET', !crypto && 'TOKEN_ENCRYPTION_KEY'].filter(Boolean), plan: account && service ? service.latestPlan(account.id) : null, runs: account ? store.all('SELECT id,kind,status,total,changed,skipped,detail,created FROM runs WHERE account_id=? ORDER BY created DESC LIMIT 30', account.id).map(run => ({ ...run, undoable: Boolean(store.get("SELECT id FROM changes WHERE run_id=? AND status IN ('applied','uncertain','undo_uncertain') LIMIT 1", run.id)) })) : [], subscriptions: account ? store.all('SELECT sender,host,status FROM subscriptions WHERE account_id=? ORDER BY sender LIMIT 200', account.id) : [] });
      }
      if (url.pathname === '/auth/google' && req.method === 'GET') {
        if (!ready) return redirect(res, '/?auth=setup');
        if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return json(res, 403, { error: 'Start connection from this app.' });
        if (!session) session = newSession(res);
        const state = randomToken(); const verifier = randomToken();
        store.run('INSERT INTO oauth_states(id,session_id,verifier,expires) VALUES(?,?,?,?)', hash(state), session.id, crypto.seal(verifier), Date.now() + 600000);
        const parameters = new URLSearchParams({ client_id: config.clientId, redirect_uri: `${origin}/auth/google/callback`, response_type: 'code', scope: 'https://www.googleapis.com/auth/gmail.modify', access_type: 'offline', prompt: 'consent', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
        return redirect(res, `https://accounts.google.com/o/oauth2/v2/auth?${parameters}`);
      }
      if (url.pathname === '/auth/google/callback' && req.method === 'GET') {
        if (!ready) return redirect(res, '/?auth=setup');
        const state = store.get('SELECT * FROM oauth_states WHERE id=? AND session_id=? AND expires>?', hash(url.searchParams.get('state') || ''), session?.id || '', Date.now());
        if (!state) return redirect(res, '/?auth=state');
        store.run('DELETE FROM oauth_states WHERE id=?', state.id);
        if (url.searchParams.has('error') || !url.searchParams.get('code')) return redirect(res, '/?auth=cancelled');
        try {
          const tokens = await jsonFetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: `${origin}/auth/google/callback`, grant_type: 'authorization_code', code: url.searchParams.get('code'), code_verifier: crypto.open(state.verifier) }) });
          if (!tokens.scope?.split(' ').includes('https://www.googleapis.com/auth/gmail.modify')) throw new Error('Gmail permission was not granted.');
          const profile = await jsonFetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
          if (!profile.emailAddress) throw new Error('Gmail account not available.');
          const accountId = profile.emailAddress.toLowerCase();
          const previous = store.get('SELECT tokens FROM accounts WHERE id=?', accountId);
          if (!tokens.refresh_token && previous) tokens.refresh_token = crypto.open(previous.tokens).refresh_token;
          if (!tokens.refresh_token) throw new Error('Offline access was not granted.');
          tokens.expires_at = Date.now() + tokens.expires_in * 1000;
          store.run('INSERT INTO accounts(id,email,tokens,rules,created) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET tokens=excluded.tokens,last_error=NULL', accountId, profile.emailAddress, crypto.seal(tokens), JSON.stringify(DEFAULT_RULES), Date.now());
          store.run('DELETE FROM sessions WHERE id=?', session.id); newSession(res, accountId);
          return redirect(res, '/?auth=connected');
        } catch { return redirect(res, '/?auth=failed'); }
      }
      if (url.pathname.startsWith('/api/')) {
        if (!session?.account_id || !service) return json(res, 401, { error: 'Connect Gmail to continue.' });
        const id = session.account_id;
        if (req.method === 'GET' && url.pathname === '/api/mailbox') {
          const gmail = service.client(service.account(id));
          const [profile, labels] = await Promise.all([gmail('profile'), gmail('labels/UNREAD')]);
          return json(res, 200, { email: profile.emailAddress, messages: profile.messagesTotal, unread: labels.messagesUnread ?? labels.messagesTotal ?? 0 });
        }
        if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
        if (req.headers.origin !== origin || req.headers['x-csrf-token'] !== session.csrf || !req.headers['content-type']?.startsWith('application/json')) return json(res, 403, { error: 'Request could not be verified. Reload the app and try again.' });
        const input = await body(req);
        if (url.pathname === '/api/rules') return json(res, 200, { rules: service.saveRules(id, input) });
        if (url.pathname === '/api/scan') return json(res, 200, { plan: await service.scan(id, 'manual', typeof input.nextPlanId === 'string' ? input.nextPlanId : null) });
        if (url.pathname === '/api/discover') return json(res, 200, await service.discover(id));
        if (url.pathname === '/api/apply') return json(res, 200, await service.apply(id, input.planId, input.ids));
        if (url.pathname === '/api/undo') return json(res, 200, await service.undo(id, input.runId));
        if (url.pathname === '/api/unsubscribe') return json(res, 200, await service.unsubscribe(id, input.sender));
        if (url.pathname === '/api/logout') { store.run('DELETE FROM sessions WHERE id=?', session.id); res.setHeader('Set-Cookie', cookie('', 0)); return json(res, 200, { success: true }); }
        if (url.pathname === '/api/disconnect') return json(res, 200, await service.locked(id, async () => {
          const account = service.account(id);
          // Revoke server-side; if revocation fails keep the account paused so the
          // user can retry instead of falsely reporting a complete disconnect.
          store.run('UPDATE accounts SET rules=? WHERE id=?', JSON.stringify({ ...account.rules, daily: false }), id);
          const revoked = await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: account.tokens.refresh_token }), signal: AbortSignal.timeout(15000) });
          if (!revoked.ok) throw new Error('Agent paused, but Google revocation failed. Try disconnecting again or remove app access from your Google account.');
          store.db.exec('BEGIN IMMEDIATE');
          try {
            for (const table of ['changes', 'plans', 'runs', 'subscriptions']) store.run(`DELETE FROM ${table} WHERE account_id=?`, id);
            store.run('DELETE FROM sessions WHERE account_id=?', id); store.run('DELETE FROM accounts WHERE id=?', id); store.db.exec('COMMIT');
          } catch (error) { store.db.exec('ROLLBACK'); throw error; }
          res.setHeader('Set-Cookie', cookie('', 0)); return { success: true };
        }));
        return json(res, 404, { error: 'Not found.' });
      }
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const [file, type] = assets.get(url.pathname); const content = await readFile(resolve(root, file));
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); return res.end(content);
      }
      return json(res, 404, { error: 'Not found.' });
    } catch (error) {
      // No raw provider responses or tokens in errors/logs.
      const safe = /SQLITE|constraint|database|fetch failed|ENOENT/i.test(error.message) ? 'The operation could not complete. Please try again or check the server configuration.' : error.message;
      return json(res, 400, { error: safe });
    }
  });
  let ticking = false;
  const tick = async () => {
    if (!service || ticking) return;
    ticking = true;
    try {
      store.run("UPDATE runs SET status='needs_review',detail='Server stopped before completion. Review recorded changes; uncertain writes are not retried.' WHERE status='running' AND account_id NOT IN (SELECT account_id FROM locks WHERE expires>?)", Date.now());
      store.run("UPDATE plans SET status='needs_review' WHERE status='applying' AND account_id NOT IN (SELECT account_id FROM locks WHERE expires>?)", Date.now());
      await service.daily();
    } catch { console.error('Daily agent encountered an error; check account activity.'); } finally { ticking = false; }
    store.run('DELETE FROM sessions WHERE expires<?', Date.now()); store.run('DELETE FROM oauth_states WHERE expires<?', Date.now());
  };
  let timer;
  return { server, store, service, config, start() { server.listen(config.port, config.host, () => console.log(`Inboxclean is ready at ${origin}${ready ? '' : ' — Gmail setup required'}`)); timer = setInterval(tick, 60000); timer.unref(); tick(); }, async close() { clearInterval(timer); await new Promise(resolve => server.close(resolve)); store.close(); } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApp(); app.start();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
