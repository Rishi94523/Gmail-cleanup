import { publicFailure } from './failures.js';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { openPostgresStore } from './postgres-store.js';
import { encryption, randomToken, hash } from './security.js';
import { DEFAULT_RULES } from './rules.js';
import { InboxService } from './service.js';
import { jsonFetch, primaryUnreadCount, revokeGoogleToken } from './gmail.js';
import { learnInbox, runAgent } from './agent.js';
import { aiConfig } from './ai.js';
import { learningTray, answerPreference, editMemory, interpretPreference, interpretNotes, saveNotes } from './learning.js';
import { accessFor, requirePaid, restartTrial } from './access.js';
import { PREFERENCE_CATEGORIES } from './preference-categories.js';
import { schedulerAuthorized } from './scheduler.js';

export async function createApp(options = {}) {
  const config = { hackathonMode: process.env.HACKATHON_MODE === 'true', schedulerAccount: process.env.SCHEDULER_SERVICE_ACCOUNT || '', port: Number(process.env.PORT || 3000), host: process.env.HOST || '127.0.0.1', appUrl: process.env.APP_URL || 'http://localhost:3000', clientId: process.env.GOOGLE_CLIENT_ID || '', clientSecret: process.env.GOOGLE_CLIENT_SECRET || '', encryptionKey: process.env.TOKEN_ENCRYPTION_KEY || '', ...aiConfig(), databaseUrl: process.env.DATABASE_URL || '', scheduler: !process.env.K_SERVICE && process.env.ENABLE_LOCAL_SCHEDULER !== 'false', ...options.config };
  config.serveLanding ??= process.env.SERVE_LANDING === 'true' || Boolean(process.env.K_SERVICE);
  const workspace = config.serveLanding ? '/app' : '/';
  const origin = new URL(config.appUrl).origin;
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname) && !origin.startsWith('https://')) throw new Error('APP_URL must use HTTPS outside localhost.');
  if (process.env.K_SERVICE && !config.databaseUrl && !options.store) throw new Error('Cloud Run requires a shared Postgres DATABASE_URL. SQLite is local-only.');
  const store = options.store || (config.databaseUrl ? await openPostgresStore(config.databaseUrl) : (await import('./store.js')).openStore(options.dataDir));
  const crypto = config.encryptionKey ? encryption(config.encryptionKey) : null;
  const ready = Boolean(crypto && config.clientId && config.clientSecret);
  const service = crypto ? new InboxService(store, crypto, config, options.clientFactory) : null;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
  const assets = new Map([['/favicon.svg', ['favicon.svg', 'image/svg+xml']], ['/customer-message.js', ['customer-message.js', 'text/javascript']], ['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']], ['/onboarding.js', ['onboarding.js', 'text/javascript']], ['/onboarding.css', ['onboarding.css', 'text/css']], ['/preference-answer.js', ['preference-answer.js', 'text/javascript']]]);
  function cookie(value, maxAge = 2592000) { return `inboxclean_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${origin.startsWith('https:') ? '; Secure' : ''}`; }
  function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }
  function redirect(res, to) { res.writeHead(302, { Location: to }); res.end(); }
  async function newSession(res, accountId = null) {
    const token = randomToken(); const session = { id: hash(token), account_id: accountId, csrf: randomToken(), expires: Date.now() + 2592000000 };
    await store.run('INSERT INTO sessions(id,account_id,csrf,expires) VALUES(?,?,?,?)', session.id, session.account_id, session.csrf, session.expires);
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
      if (url.pathname === '/internal/scheduler/tick') {
        if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
        if (!await schedulerAuthorized(req.headers.authorization, config, options.verifySchedulerIdentity)) return json(res, 401, { error: 'Scheduler identity required.' });
        const result = await tick();
        return json(res, result.status === 'failed' ? 500 : 200, result);
      }
      if (url.pathname === '/api/health' && req.method === 'GET') {
        try { await store.get('SELECT 1 AS connected'); return json(res, 200, { database: store.kind, connected: true, gmailConfigured: ready, aiConfigured: Boolean(config.aiKey), stage: 'gmail-agent', freeEmailLimit: 100 }); }
        catch { return json(res, 503, { database: store.kind, connected: false }); }
      }
      const token = req.headers.cookie?.split(';').map(p => p.trim()).find(p => p.startsWith('inboxclean_session='))?.slice(19);
      session = token ? await store.get('SELECT * FROM sessions WHERE id=? AND expires>?', hash(token), Date.now()) : null;
      if (url.pathname === '/api/status' && req.method === 'GET') {
        if (!session) session = await newSession(res);
        const account = session.account_id ? await store.get('SELECT id,email,rules,last_day,last_error FROM accounts WHERE id=?', session.account_id) : null;
        const details = account ? await Promise.all([
          store.get("SELECT coalesce(sum(changed),0) AS total FROM runs WHERE account_id=? AND status!='undone'", account.id),
          store.get("SELECT count(*) AS total FROM subscriptions WHERE account_id=? AND status='requested'", account.id),
          store.all("SELECT r.id,r.kind,r.status,r.total,r.changed,r.skipped,r.detail,r.created,EXISTS(SELECT 1 FROM changes c WHERE c.run_id=r.id AND c.account_id=r.account_id AND c.status IN ('applied','uncertain','undo_uncertain')) AS undoable FROM runs r WHERE r.account_id=? ORDER BY r.created DESC LIMIT 30", account.id),
          store.all('SELECT sender,message_id,host,status,payload FROM subscriptions WHERE account_id=? ORDER BY sender LIMIT 200', account.id),
          service ? service.latestPlan(account.id) : null
        ]) : null;
        return json(res, 200, { csrf: session.csrf, configured: ready, aiConfigured: Boolean(config.aiKey), aiProvider: config.aiProvider, aiModel: config.aiModel, preferenceCategories: PREFERENCE_CATEGORIES, hackathonMode: config.hackathonMode, schedulerActive: Boolean(config.scheduler || config.schedulerAccount), connected: Boolean(account), email: account?.email || null, access: account ? await accessFor(service, account.id) : null, rules: account ? JSON.parse(account.rules) : DEFAULT_RULES, lastDay: account?.last_day || null, lastError: account?.last_error || null, totals: details ? { cleaned: details[0].total, requested: details[1].total } : null, setupMissing: [!config.clientId && 'GOOGLE_CLIENT_ID', !config.clientSecret && 'GOOGLE_CLIENT_SECRET', !crypto && 'TOKEN_ENCRYPTION_KEY'].filter(Boolean), plan: details?.[4] || null, runs: details ? details[2].map(run => ({ ...run, undoable: Boolean(run.undoable) })) : [], subscriptions: (details?.[3] || []).map(({ payload, message_id, ...subscription }) => ({ ...subscription, messageId: message_id, ...(payload ? crypto.open(payload) : {}) })) });
      }
      if (url.pathname === '/auth/google' && req.method === 'GET') {
        if (!ready) return redirect(res, `${workspace}?auth=setup`);
        if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return json(res, 403, { error: 'Start connection from this app.' });
        if (!session) session = await newSession(res);
        const state = randomToken(); const verifier = randomToken();
        await store.run('INSERT INTO oauth_states(id,session_id,verifier,expires) VALUES(?,?,?,?)', hash(state), session.id, crypto.seal(verifier), Date.now() + 600000);
        const parameters = new URLSearchParams({ client_id: config.clientId, redirect_uri: `${origin}/auth/google/callback`, response_type: 'code', scope: 'https://www.googleapis.com/auth/gmail.modify', access_type: 'offline', prompt: 'consent', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
        return redirect(res, `https://accounts.google.com/o/oauth2/v2/auth?${parameters}`);
      }
      if (url.pathname === '/auth/google/callback' && req.method === 'GET') {
        if (!ready) return redirect(res, `${workspace}?auth=setup`);
        const state = await store.get('DELETE FROM oauth_states WHERE id=? AND session_id=? AND expires>? RETURNING *', hash(url.searchParams.get('state') || ''), session?.id || '', Date.now());
        if (!state) return redirect(res, `${workspace}?auth=state`);
        if (url.searchParams.has('error') || !url.searchParams.get('code')) return redirect(res, `${workspace}?auth=cancelled`);
        try {
          const tokens = await jsonFetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: `${origin}/auth/google/callback`, grant_type: 'authorization_code', code: url.searchParams.get('code'), code_verifier: crypto.open(state.verifier) }) });
          if (!tokens.scope?.split(' ').includes('https://www.googleapis.com/auth/gmail.modify')) throw new Error('Gmail permission was not granted.');
          const profile = await jsonFetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
          if (!profile.emailAddress) throw new Error('Gmail account not available.');
          const accountId = profile.emailAddress.toLowerCase();
          const previous = await store.get('SELECT tokens FROM accounts WHERE id=?', accountId);
          if (!tokens.refresh_token && previous) tokens.refresh_token = crypto.open(previous.tokens).refresh_token;
          if (!tokens.refresh_token) throw new Error('Offline access was not granted.');
          tokens.expires_at = Date.now() + tokens.expires_in * 1000;
          await store.run('INSERT INTO accounts(id,email,tokens,rules,created) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET tokens=excluded.tokens,last_error=NULL', accountId, profile.emailAddress, crypto.seal(tokens), JSON.stringify(DEFAULT_RULES), Date.now());
          await store.run('DELETE FROM sessions WHERE id=?', session.id); await newSession(res, accountId);
          return redirect(res, `${workspace}?auth=connected`);
        } catch { return redirect(res, `${workspace}?auth=failed`); }
      }
      if (url.pathname.startsWith('/api/')) {
        if (!session?.account_id || !service) return json(res, 401, { error: 'Connect Gmail to continue.' });
        const id = session.account_id;
        if (req.method === 'GET' && url.pathname === '/api/agent/questions') return json(res, 200, await learningTray(service, id));
        if (req.method === 'GET' && url.pathname === '/api/mailbox') {
          const account = await service.account(id); const gmail = service.client(account);
          const unread = await primaryUnreadCount(gmail);
          return json(res, 200, { email: account.email, unread: unread.count, unreadCapped: unread.capped, scope: 'primary' });
        }
        if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
        if (req.headers.origin !== origin || req.headers['x-csrf-token'] !== session.csrf || !req.headers['content-type']?.startsWith('application/json')) return json(res, 403, { error: 'Request could not be verified. Reload the app and try again.' });
        const input = await body(req);
        if (url.pathname === '/api/agent/questions/answer') return json(res, 200, await answerPreference(service, id, input));
        if (url.pathname === '/api/agent/questions/interpret') return json(res, 200, await service.locked(id, () => interpretPreference(service, id, input)));
        if (url.pathname === '/api/agent/preferences/interpret') return json(res, 200, await service.locked(id, () => interpretNotes(service, id, input)));
        if (url.pathname === '/api/agent/preferences/save') return json(res, 200, await saveNotes(service, id, input));
        if (url.pathname === '/api/agent/memories/edit') return json(res, 200, await editMemory(service, id, input));
        if (url.pathname === '/api/agent/learn') return json(res, 200, await service.locked(id, () => learnInbox(service, id, input.consent, input.provider)));
        if (url.pathname === '/api/agent/reassess-trial') return json(res, 200, await service.locked(id, () => restartTrial(service, id, input.authorize)));
        if (url.pathname === '/api/agent/history') {
          const logs = await store.all("SELECT payload FROM plans WHERE account_id=? AND status='agent_log' ORDER BY created DESC LIMIT 10", id);
          return json(res, 200, { logs: logs.map(row => crypto.open(row.payload)) });
        }
        if (url.pathname === '/api/agent/run') {
          if (input.authorize !== true) throw new Error('Authorize the agent to act using your saved preferences.');
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'X-Accel-Buffering': 'no' });
          const emit = event => { if (!res.destroyed) res.write(`${JSON.stringify(event)}\n`); };
          const heartbeat = setInterval(() => emit({ type: 'heartbeat' }), 10000);
          try { await service.locked(id, guard => runAgent(service, id, guard, emit)); }
          catch (error) { emit({ type: 'error', ...publicFailure(error) }); }
          finally { clearInterval(heartbeat); res.end(); }
          return;
        }
        if (url.pathname === '/api/rules') return json(res, 200, { rules: await service.saveRules(id, input) });
        if (url.pathname === '/api/routine/pause') return json(res, 200, await service.pauseDaily(id, input.duration));
        if (['/api/scan', '/api/discover', '/api/apply', '/api/unsubscribe'].includes(url.pathname)) await requirePaid(service, id);
        if (url.pathname === '/api/scan') return json(res, 200, { plan: await service.scan(id, 'manual', typeof input.nextPlanId === 'string' ? input.nextPlanId : null) });
        if (url.pathname === '/api/discover') return json(res, 200, await service.discover(id));
        if (url.pathname === '/api/apply') return json(res, 200, await service.apply(id, input.planId, input.ids));
        if (url.pathname === '/api/undo') return json(res, 200, await service.undo(id, input.runId));
        if (url.pathname === '/api/unsubscribe') return json(res, 200, await service.unsubscribe(id, input.sender));
        if (url.pathname === '/api/logout') { await store.run('DELETE FROM sessions WHERE id=?', session.id); res.setHeader('Set-Cookie', cookie('', 0)); return json(res, 200, { success: true }); }
        if (url.pathname === '/api/disconnect') return json(res, 200, await service.locked(id, async () => {
          const account = await service.account(id);
          // Revoke server-side; if revocation fails keep the account paused so the
          // user can retry instead of falsely reporting a complete disconnect.
          await store.run('UPDATE accounts SET rules=? WHERE id=?', JSON.stringify({ ...account.rules, daily: false }), id);
          await revokeGoogleToken(account.tokens.refresh_token, options.fetch);
          await store.transaction(async tx => {
            for (const table of ['changes', 'plans', 'runs', 'subscriptions', 'agent_assessments', 'agent_questions', 'preference_memories', 'preference_events', 'agent_holds', 'subscription_actions', 'agent_discoveries', 'trial_samples']) await tx.run(`DELETE FROM ${table} WHERE account_id=?`, id);
            await tx.run('DELETE FROM sessions WHERE account_id=?', id); await tx.run('DELETE FROM accounts WHERE id=?', id);
          });
          res.setHeader('Set-Cookie', cookie('', 0)); return { success: true };
        }));
        return json(res, 404, { error: 'Not found.' });
      }
      if (req.method === 'GET' && config.serveLanding && (url.pathname === '/' || url.pathname.startsWith('/assets/'))) {
        const landingRoot = resolve(root, '../web/dist');
        const file = resolve(landingRoot, url.pathname === '/' ? 'index.html' : `.${decodeURIComponent(url.pathname)}`);
        if (!file.startsWith(`${landingRoot}${sep}`)) return json(res, 404, { error: 'Not found.' });
        const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : null;
        if (!type) return json(res, 404, { error: 'Not found.' });
        const content = await readFile(file); res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); return res.end(content);
      }
      if (req.method === 'GET' && url.pathname === '/app') {
        const content = await readFile(resolve(root, 'index.html')); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(content);
      }
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const [file, type] = assets.get(url.pathname); const content = await readFile(resolve(root, file));
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); return res.end(content);
      }
      return json(res, 404, { error: 'Not found.' });
    } catch (error) {
      // No raw provider responses or tokens in errors/logs.
      const databaseError = /^[0-9A-Z]{5}$/.test(error.code || '') || /SQLITE|constraint|database|fetch failed|ENOENT/i.test(error.message);
      const internal = databaseError || /Nebius|API[_ -]?KEY|AI_PROVIDER|AI_MODEL|OAuth client|redirect URI|README|\.env\b|model access|provider.*changed/i.test(error.message);
      const safe = error.publicCode ? publicFailure(error).message : internal ? 'This feature is temporarily unavailable. Please try again later.' : error.message;
      // 5xx for our own failures (500) and failed Gmail/AI calls (502), so they show up in Cloud Run error metrics.
      const status = error.publicCode ? 502 : internal ? 500 : error.status && error.status !== 401 ? 502 : 400;
      if (status >= 500) console.error(JSON.stringify({ event: 'request_failed', path: url?.pathname, status, code: error.publicCode || error.code || null }));
      return json(res, status, { error: safe, ...(error.publicCode ? { code: error.publicCode } : {}) });
    }
  });
  let ticking = false; let lastPrune = 0;
  const tick = async () => {
    if (!service || ticking) return { status: 'busy' };
    ticking = true;
    try {
      await store.run("UPDATE runs SET status='needs_review',detail='Server stopped before completion. Review recorded changes; uncertain writes are not retried.' WHERE status='running' AND account_id NOT IN (SELECT account_id FROM locks WHERE expires>?)", Date.now());
      await store.run("UPDATE plans SET status='needs_review' WHERE status='applying' AND account_id NOT IN (SELECT account_id FROM locks WHERE expires>?)", Date.now());
      await service.daily();
      await store.run('DELETE FROM sessions WHERE expires<?', Date.now()); await store.run('DELETE FROM oauth_states WHERE expires<?', Date.now());
      if (Date.now() - lastPrune >= 3600000) { await service.prune(); lastPrune = Date.now(); }
      return { status: 'completed' };
    } catch { console.error('Daily agent encountered an error; check account activity.'); return { status: 'failed' }; } finally { ticking = false; }
  };
  let timer; let tickPromise = Promise.resolve();
  const runTick = () => { if (!ticking) tickPromise = tick(); };
  return { server, store, service, config, start() { server.listen(config.port, config.host, () => console.log(`Inboxclean is ready at ${origin}${ready ? '' : ' — Gmail setup required'}`)); if (config.scheduler) { timer = setInterval(runTick, 60000); timer.unref(); runTick(); } }, async close() { clearInterval(timer); await tickPromise; await new Promise(resolve => server.close(resolve)); await store.close(); } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createApp(); app.start();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
