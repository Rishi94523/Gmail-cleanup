import { accessFor, requirePaid } from './access.js';
import { randomUUID } from 'node:crypto';
import { DEFAULT_RULES, validateRules, gmailQuery, headersOf, senderAddress, protectedReason, changesFor, undoChanges, dailyKey } from './rules.js';
import { gmailClient, metadata, mapLimit, classify } from './gmail.js';
import { unsubscribeUrl, postUnsubscribe } from './security.js';
import { preferences, runAgent } from './agent.js';
import { missingAIKey } from './ai.js';
import { choicesFor } from './learning.js';

export class InboxService {
  constructor(store, crypto, config, clientFactory = gmailClient) { this.store = store; this.crypto = crypto; this.config = config; this.clientFactory = clientFactory; }
  async account(id) {
    const account = await this.store.get('SELECT * FROM accounts WHERE id=?', id);
    if (!account) throw new Error('Connect Gmail to continue.');
    return { ...account, rules: JSON.parse(account.rules), tokens: this.crypto.open(account.tokens) };
  }
  client(account) { return this.clientFactory(account, this.config, async tokens => await this.store.run('UPDATE accounts SET tokens=? WHERE id=?', this.crypto.seal(tokens), account.id)); }
  async locked(id, fn) {
    const owner = randomUUID(); const now = Date.now();
    const locked = await this.store.run('INSERT INTO locks(account_id,owner,expires) VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE locks.expires<?', id, owner, now + 180000, now);
    if (!locked.changes) throw new Error('An operation is already running for this account.');
    let heartbeatFailed = false;
    const heartbeat = setInterval(async () => {
      try { const renewed = await this.store.run('UPDATE locks SET expires=? WHERE account_id=? AND owner=?', Date.now() + 180000, id, owner); if (!renewed.changes) heartbeatFailed = true; }
      catch { heartbeatFailed = true; }
    }, 30000);
    heartbeat.unref();
    try { return await fn(async () => { const lock = await this.store.get('SELECT owner,expires FROM locks WHERE account_id=?', id); if (heartbeatFailed || lock?.owner !== owner || lock.expires <= Date.now()) throw new Error('Operation lock expired. Review activity before trying again.'); }); }
    finally { clearInterval(heartbeat); await this.store.run('DELETE FROM locks WHERE account_id=? AND owner=?', id, owner); }
  }
  async saveRules(id, input) {
    if (input.daily) await requirePaid(this, id);
    const existingAgent = (await this.account(id)).rules.agent;
    const agent = input.agent ? { ...existingAgent, ...input.agent } : existingAgent;
    const rules = { ...validateRules(input), aiConsentProvider: input.aiConsentProvider || '', ...(agent ? { agent: preferences(agent) } : {}) };
    if ((rules.agent?.enabled || rules.aiEnabled) && !this.config.aiKey) throw new Error(missingAIKey(this.config));
    if (rules.agent?.enabled && rules.agent.consentProvider !== (this.config.aiProvider || 'openrouter')) throw new Error('Confirm AI processing for the selected provider in Preferences.');
    if (rules.aiEnabled && rules.aiConsentProvider !== (this.config.aiProvider || 'openrouter')) throw new Error('Confirm AI processing for the selected provider before enabling advanced AI review.');
    await this.store.transaction(async tx => {
      await tx.run('UPDATE accounts SET rules=? WHERE id=?', JSON.stringify(rules), id);
      await tx.run("UPDATE plans SET status='expired' WHERE account_id=? AND status='ready'", id);
      // Discovery may precede the final read/archive selection. Keep unanswered
      // setup choices aligned with that permission before showing the questions.
      for (const question of await tx.all("SELECT id,payload FROM agent_questions WHERE account_id=? AND status='pending'", id)) {
        const payload = this.crypto.open(question.payload);
        if (!payload.initial) continue;
        const options = choicesFor(preferences(rules.agent), payload.scope).map(o => ({ ...o, label: o.label.replace('future low-priority mail', 'low-priority emails in this first cleanup') }));
        if (JSON.stringify(payload.options) !== JSON.stringify(options)) await tx.run('UPDATE agent_questions SET payload=?,version=version+1,updated=? WHERE id=? AND account_id=?', this.crypto.seal({ ...payload, options }), Date.now(), question.id, id);
      }
    });
    return rules;
  }
  async scan(id, mode = 'manual', nextPlanId = null) { return this.locked(id, () => this.scanUnlocked(id, mode, nextPlanId)); }
  async recordSubscriptions(id, messages) {
    for (const message of messages) {
      const headers = headersOf(message); if (!headers['list-unsubscribe']) continue;
      const sender = senderAddress(headers.from); const url = unsubscribeUrl(headers);
      await this.store.run("INSERT INTO subscriptions(account_id,sender,message_id,host,status) VALUES(?,?,?,?,?) ON CONFLICT(account_id,sender) DO UPDATE SET message_id=excluded.message_id,host=excluded.host,status=excluded.status WHERE subscriptions.status IN ('review','manual')", id, sender, message.id, url?.hostname || null, url ? 'review' : 'manual');
    }
  }
  async discover(id) { return this.locked(id, async () => {
    const gmail = this.client(await this.account(id));
    const listed = await gmail(`messages?${new URLSearchParams({ q: 'in:inbox', maxResults: '100' })}`);
    const messages = await mapLimit(listed.messages || [], 5, async ({ id }) => { try { return await metadata(gmail, id); } catch (error) { if (error.status === 404) return null; throw error; } });
    await this.recordSubscriptions(id, messages.filter(Boolean));
    return { inspected: messages.filter(Boolean).length, moreAvailable: Boolean(listed.nextPageToken) };
  }); }
  async scanUnlocked(id, mode, nextPlanId = null) {
    const account = await this.account(id); const gmail = this.client(account);
    let pageToken;
    if (nextPlanId) {
      const previous = await this.store.get("SELECT payload FROM plans WHERE id=? AND account_id=? AND status='ready'", nextPlanId, id);
      if (!previous) throw new Error('Previous batch expired. Start a new scan.');
      const previousPlan = this.crypto.open(previous.payload);
      if (JSON.stringify(previousPlan.rules) !== JSON.stringify(account.rules) || !previousPlan.nextPageToken) throw new Error('There is no next batch for these rules. Start a new scan.');
      pageToken = previousPlan.nextPageToken;
    }
    const listed = await gmail(`messages?${new URLSearchParams({ q: gmailQuery(account.rules), maxResults: '100', ...(pageToken ? { pageToken } : {}) })}`);
    const messages = await mapLimit(listed.messages || [], 5, async ({ id }) => { try { return await metadata(gmail, id); } catch (error) { if (error.status === 404) return null; throw error; } });
    const present = messages.filter(Boolean);
    const decisions = await classify(present, account.rules, this.config);
    const plan = { id: randomUUID(), rules: account.rules, messages: present, decisions, nextPageToken: listed.nextPageToken || null, moreAvailable: Boolean(listed.nextPageToken), created: Date.now(), mode };
    await this.store.run("UPDATE plans SET status='expired' WHERE account_id=? AND status='ready'", id);
    await this.store.run("INSERT INTO plans(id,account_id,payload,status,created) VALUES(?,?,?,'ready',?)", plan.id, id, this.crypto.seal(plan), plan.created);
    await this.recordSubscriptions(id, present);
    return this.planView(plan);
  }
  planView(plan) { return { id: plan.id, created: plan.created, moreAvailable: plan.moreAvailable, decisions: plan.decisions.map(({ labels, ...decision }) => decision), rules: plan.rules }; }
  async latestPlan(id) {
    const row = await this.store.get("SELECT payload FROM plans WHERE account_id=? AND status='ready' AND created>? ORDER BY created DESC LIMIT 1", id, Date.now() - 3600000);
    return row ? this.planView(this.crypto.open(row.payload)) : null;
  }
  async label(gmail) {
    const labels = await gmail('labels'); const found = labels.labels?.find(l => l.name === 'Cleaned by agent');
    if (found) return found.id;
    const created = await gmail('labels', { name: 'Cleaned by agent', labelListVisibility: 'labelShow', messageListVisibility: 'show' }); return created.id;
  }
  async apply(id, planId, selected, mode = 'manual') { return this.locked(id, guard => this.applyUnlocked(id, planId, selected, mode, guard)); }
  async applyUnlocked(id, planId, selected, mode, guard) {
    const row = await this.store.get('SELECT * FROM plans WHERE id=? AND account_id=?', planId, id);
    if (!row || row.status !== 'ready' || Date.now() - row.created > 3600000) throw new Error('This preview has expired or already been used. Scan again.');
    const account = await this.account(id); const plan = this.crypto.open(row.payload);
    if (JSON.stringify(plan.rules) !== JSON.stringify(account.rules)) throw new Error('Your rules changed. Scan again to create a fresh preview.');
    const eligible = new Set(plan.decisions.filter(d => !d.reason).map(d => d.id));
    if (!Array.isArray(selected) || selected.length > 100 || selected.some(id => typeof id !== 'string' || !eligible.has(id))) throw new Error('Select messages from this cleanup preview.');
    const ids = [...new Set(selected)]; if (!ids.length) throw new Error('Select at least one message.');
    const runId = randomUUID(); const gmail = this.client(account);
    const claimed = await this.store.run("UPDATE plans SET status='applying' WHERE id=? AND status='ready'", planId);
    if (!claimed.changes) throw new Error('This preview is already being applied.');
    await this.store.run("INSERT INTO runs(id,account_id,kind,status,total,created) VALUES(?,?,?,'running',?,?)", runId, id, mode === 'daily' ? 'daily' : 'cleanup', ids.length, Date.now());
    let changed = 0; let skipped = 0;
    try {
      const cleanedLabel = await this.label(gmail);
      for (const messageId of ids) {
        await guard();
        const freshAccount = await this.account(id);
        if (mode === 'daily' && !freshAccount.rules.daily) throw new Error('Daily agent paused. Remaining messages were left unchanged.');
        if (JSON.stringify(freshAccount.rules) !== JSON.stringify(account.rules)) throw new Error('Rules changed during cleanup. Remaining messages were left unchanged.');
        let message;
        try { message = await metadata(gmail, messageId); } catch (error) { if (error.status === 404) { skipped++; continue; } throw error; }
        if (protectedReason(message, freshAccount.rules)) { skipped++; continue; }
        const beforeWrite = (await this.account(id)).rules;
        if ((mode === 'daily' && !beforeWrite.daily) || JSON.stringify(beforeWrite) !== JSON.stringify(account.rules)) throw new Error('Rules changed or the agent was paused. Remaining messages were left unchanged.');
        const change = changesFor(message, account.rules, cleanedLabel);
        if (!change.addLabelIds.length && !change.removeLabelIds.length) { skipped++; continue; }
        const changeId = randomUUID();
        await this.store.run("INSERT INTO changes(id,run_id,account_id,message_id,payload,status,created) VALUES(?,?,?,?,?,'uncertain',?)", changeId, runId, id, messageId, this.crypto.seal(change), Date.now());
        // Persist before the write: a timeout/crash is uncertain and is never replayed.
        await gmail(`messages/${encodeURIComponent(messageId)}/modify`, change);
        await this.store.run("UPDATE changes SET status='applied' WHERE id=?", changeId); changed++;
        await this.store.run('UPDATE runs SET changed=?,skipped=? WHERE id=?', changed, skipped, runId);
      }
      await this.store.run("UPDATE runs SET status='completed',changed=?,skipped=? WHERE id=?", changed, skipped, runId);
      await this.store.run("UPDATE plans SET status='applied' WHERE id=?", planId);
      return { id: runId, changed, skipped };
    } catch (error) {
      await this.store.run("UPDATE runs SET status='needs_review',changed=?,skipped=?,detail=? WHERE id=?", changed, skipped, error.message, runId);
      await this.store.run("UPDATE plans SET status='needs_review' WHERE id=?", planId); throw new Error(`${error.message} ${changed} messages confirmed changed; review activity before continuing.`);
    }
  }
  async undo(id, runId) { return this.locked(id, async guard => {
    const run = await this.store.get('SELECT * FROM runs WHERE id=? AND account_id=?', runId, id);
    if (!run || !['cleanup', 'daily'].includes(run.kind)) throw new Error('Cleanup run not found.');
    const changes = await this.store.all("SELECT * FROM changes WHERE run_id=? AND account_id=? AND status IN ('applied','uncertain','undo_uncertain')", runId, id);
    if (!changes.length) throw new Error('There are no remaining changes to undo.');
    const gmail = this.client(await this.account(id)); let restored = 0;
    for (const row of changes) {
      await guard(); const change = this.crypto.open(row.payload);
      const message = await metadata(gmail, row.message_id);
      const inverse = undoChanges(change);
      // Undo only labels actually touched by this run; unrelated labels survive.
      const body = { addLabelIds: inverse.addLabelIds.filter(l => !message.labelIds?.includes(l)), removeLabelIds: inverse.removeLabelIds.filter(l => message.labelIds?.includes(l)) };
      await this.store.run("UPDATE changes SET status='undo_uncertain' WHERE id=?", row.id);
      if (body.addLabelIds.length || body.removeLabelIds.length) await gmail(`messages/${encodeURIComponent(row.message_id)}/modify`, body);
      await this.store.run("UPDATE changes SET status='undone' WHERE id=?", row.id); restored++;
    }
    await this.store.run("UPDATE runs SET status='undone' WHERE id=?", runId); return { restored };
  }); }
  async unsubscribe(id, sender) { return this.locked(id, async () => {
    const row = await this.store.get('SELECT * FROM subscriptions WHERE account_id=? AND sender=?', id, sender);
    if (!row || row.status !== 'review') throw new Error('This subscription needs manual review, or a request was already submitted.');
    const gmail = this.client(await this.account(id)); const message = await metadata(gmail, row.message_id); const headers = headersOf(message);
    if (senderAddress(headers.from) !== sender) throw new Error('Sender changed. Scan again.');
    const url = unsubscribeUrl(headers);
    if (!url || url.hostname !== row.host) throw new Error('One-click unsubscribe is no longer available. Review this sender in Gmail.');
    await this.store.run("UPDATE subscriptions SET status='uncertain' WHERE account_id=? AND sender=?", id, sender);
    try {
      await postUnsubscribe(url);
      await this.store.run("UPDATE subscriptions SET status='requested' WHERE account_id=? AND sender=?", id, sender);
      await this.store.run("INSERT INTO runs(id,account_id,kind,status,total,detail,created) VALUES(?,?,'unsubscribe','requested',1,?,?)", randomUUID(), id, `Request accepted for ${sender}. The sender may take time to stop mail.`, Date.now());
      return { status: 'requested' };
    } catch (error) { throw new Error(`${error.message} Request status is uncertain; it will not be retried automatically.`); }
  }); }
  async daily() {
    for (const row of await this.store.all('SELECT id,rules,last_day FROM accounts')) {
      const rules = JSON.parse(row.rules); if (!rules.daily || !(await accessFor(this, row.id)).dailyAllowed) continue;
      const day = dailyKey(rules); if (!day || row.last_day === day) continue;
      try {
        await this.locked(row.id, async guard => {
          const latest = await this.store.get('SELECT last_day,rules FROM accounts WHERE id=?', row.id);
          if (!latest || latest.last_day === day || !JSON.parse(latest.rules).daily) return;
          // Claim once per day; interrupted/failed mutations require manual review.
          await this.store.run('UPDATE accounts SET last_day=?,last_error=NULL WHERE id=?', day, row.id);
          if (JSON.parse(latest.rules).agent?.enabled) { await runAgent(this, row.id, guard, undefined, 'daily'); return; }
          const plan = await this.scanUnlocked(row.id, 'daily');
          const selected = plan.decisions.filter(d => !d.reason).map(d => d.id);
          if (selected.length) await this.applyUnlocked(row.id, plan.id, selected, 'daily', guard);
          else await this.store.run("INSERT INTO runs(id,account_id,kind,status,total,detail,created) VALUES(?,?,'daily','completed',0,'No matching messages to clean.',?)", randomUUID(), row.id, Date.now());
        });
      } catch (error) { await this.store.run('UPDATE accounts SET last_error=? WHERE id=?', error.message, row.id); }
    }
  }
}
