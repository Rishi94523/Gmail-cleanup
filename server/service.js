import { traced, timedSync } from './telemetry.js';
import { accessFor, requirePaid } from './access.js';
import { randomUUID } from 'node:crypto';
import { validateRules, headersOf, senderAddress, undoChanges, dailyKey, dailyIsPaused } from './rules.js';
import { gmailClient, metadata, mapLimit } from './gmail.js';
import { unsubscribeUrl, postUnsubscribe } from './security.js';
import { preferences, runAgent } from './agent.js';
import { missingAIKey } from './ai.js';
import { choicesFor } from './learning.js';

export const UNDO_WINDOW = 30 * 86400000;
export const PREFERENCE_EVENT_RETENTION = 180 * 86400000;
export const AGENT_LOGS_KEPT = 10;

export class InboxService {
  constructor(store, crypto, config, clientFactory = gmailClient) {
    this.store = store;
    this.crypto = crypto
      ? {
          ...crypto,
          seal: value => timedSync('crypto.seal', () => crypto.seal(value)),
          open: value => timedSync('crypto.open', () => crypto.open(value))
        }
      : crypto;
    this.config = config;
    this.clientFactory = clientFactory;
    // Scheduled runs call the agent through this property so tests can observe them.
    this.runAgent = runAgent;
  }
  async account(id) {
    const account = await this.store.get('SELECT * FROM accounts WHERE id=?', id);
    if (!account) throw new Error('Connect Gmail to continue.');
    return { ...account, rules: JSON.parse(account.rules), tokens: this.crypto.open(account.tokens) };
  }
  client(account) {
    return this.clientFactory(
      account,
      this.config,
      async tokens =>
        await this.store.run('UPDATE accounts SET tokens=? WHERE id=?', this.crypto.seal(tokens), account.id)
    );
  }
  locked(id, fn) {
    return traced('account_operation', () => this.lockedInternal(id, fn));
  }
  async lockedInternal(id, fn) {
    const owner = randomUUID();
    const now = Date.now();
    const locked = await this.store.run(
      'INSERT INTO locks(account_id,owner,expires) VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE locks.expires<?',
      id,
      owner,
      now + 180000,
      now
    );
    if (!locked.changes) throw new Error('An operation is already running for this account.');
    let heartbeatFailed = false;
    const heartbeat = setInterval(async () => {
      try {
        const renewed = await this.store.run(
          'UPDATE locks SET expires=? WHERE account_id=? AND owner=?',
          Date.now() + 180000,
          id,
          owner
        );
        if (!renewed.changes) heartbeatFailed = true;
      } catch {
        heartbeatFailed = true;
      }
    }, 30000);
    heartbeat.unref();
    try {
      return await fn(async () => {
        const lock = await this.store.get('SELECT owner,expires FROM locks WHERE account_id=?', id);
        if (heartbeatFailed || lock?.owner !== owner || lock.expires <= Date.now())
          throw new Error('Operation lock expired. Review activity before trying again.');
      });
    } finally {
      clearInterval(heartbeat);
      await this.store.run('DELETE FROM locks WHERE account_id=? AND owner=?', id, owner);
    }
  }
  async saveRules(id, input) {
    if (input.daily) await requirePaid(this, id);
    const existingRules = (await this.account(id)).rules;
    const existingAgent = existingRules.agent;
    const agent = input.agent ? { ...existingAgent, ...input.agent } : existingAgent;
    const rules = {
      ...validateRules({ ...input, dailyPausedUntil: existingRules.dailyPausedUntil ?? 0 }),
      ...(agent ? { agent: preferences(agent) } : {})
    };
    if (rules.agent?.enabled && !this.config.aiKey) throw new Error(missingAIKey(this.config));
    if (rules.agent?.enabled && rules.agent.consentProvider !== (this.config.aiProvider || 'nebius'))
      throw new Error('Confirm AI processing for the selected provider in Preferences.');
    await this.store.transaction(async tx => {
      const updated = await tx.run(
        'UPDATE accounts SET rules=? WHERE id=? AND rules=?',
        JSON.stringify(rules),
        id,
        JSON.stringify(existingRules)
      );
      if (!updated.changes) throw new Error('Settings changed in another session. Reload before saving.');
      // Discovery may precede the final read/archive selection. Keep unanswered
      // setup choices aligned with that permission before showing the questions.
      for (const question of await tx.all(
        "SELECT id,payload FROM agent_questions WHERE account_id=? AND status='pending'",
        id
      )) {
        const payload = this.crypto.open(question.payload);
        if (!payload.initial) continue;
        const options = choicesFor(preferences(rules.agent), payload.scope);
        if (JSON.stringify(payload.options) !== JSON.stringify(options))
          await tx.run(
            'UPDATE agent_questions SET payload=?,version=version+1,updated=? WHERE id=? AND account_id=?',
            this.crypto.seal({ ...payload, options }),
            Date.now(),
            question.id,
            id
          );
      }
    });
    return rules;
  }
  async pauseDaily(id, duration) {
    const days = { day: 1, week: 7, month: 30 };
    if (!['day', 'week', 'month', 'indefinite', 'resume'].includes(duration))
      throw new Error('Choose one day, one week, one month, or until resumed.');
    // This intentionally does not wait for the agent lock: changing rules makes
    // an active daily run stop before its next email write.
    return this.store.transaction(async tx => {
      const row = await tx.get('SELECT rules FROM accounts WHERE id=?', id);
      if (!row) throw new Error('Connect Gmail to continue.');
      const rules = JSON.parse(row.rules);
      rules.dailyPausedUntil =
        duration === 'resume' ? 0 : duration === 'indefinite' ? -1 : Date.now() + days[duration] * 86400000;
      const updated = await tx.run(
        'UPDATE accounts SET rules=? WHERE id=? AND rules=?',
        JSON.stringify(rules),
        id,
        row.rules
      );
      if (!updated.changes) throw new Error('Settings changed in another session. Reload before changing the pause.');
      return { rules };
    });
  }
  async recordSubscriptions(id, messages) {
    for (const message of messages) {
      const headers = headersOf(message);
      if (!headers['list-unsubscribe']) continue;
      const sender = senderAddress(headers.from);
      const url = unsubscribeUrl(headers);
      await this.store.run(
        "INSERT INTO subscriptions(account_id,sender,message_id,host,status) VALUES(?,?,?,?,?) ON CONFLICT(account_id,sender) DO UPDATE SET message_id=excluded.message_id,host=excluded.host,status=excluded.status WHERE subscriptions.status IN ('review','manual')",
        id,
        sender,
        message.id,
        url?.hostname || null,
        url ? 'review' : 'manual'
      );
      const displayName = (headers.from || '')
        .replace(/\s*<[^>]*>.*$/, '')
        .trim()
        .replace(/^"|"$/g, '');
      await this.store.run(
        'UPDATE subscriptions SET payload=? WHERE account_id=? AND sender=?',
        this.crypto.seal({
          displayName: displayName && displayName !== sender ? displayName.slice(0, 160) : sender,
          subject: (headers.subject || '(No subject)').slice(0, 240),
          listName: (headers['list-id'] || '').split('<')[0].trim().slice(0, 120)
        }),
        id,
        sender
      );
    }
  }
  async discover(id) {
    return this.locked(id, async () => {
      const gmail = this.client(await this.account(id));
      const listed = await gmail(`messages?${new URLSearchParams({ q: 'in:inbox', maxResults: '100' })}`);
      const messages = await mapLimit(listed.messages || [], 5, async ({ id }) => {
        try {
          return await metadata(gmail, id);
        } catch (error) {
          if (error.status === 404) return null;
          throw error;
        }
      });
      await this.recordSubscriptions(id, messages.filter(Boolean));
      return { inspected: messages.filter(Boolean).length, moreAvailable: Boolean(listed.nextPageToken) };
    });
  }
  async label(gmail) {
    const labels = await gmail('labels');
    const found = labels.labels?.find(l => l.name === 'Cleaned by agent');
    if (found) return found.id;
    const created = await gmail('labels', {
      name: 'Cleaned by agent',
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show'
    });
    return created.id;
  }
  async undo(id, runId) {
    return this.locked(id, async guard => {
      const run = await this.store.get('SELECT * FROM runs WHERE id=? AND account_id=?', runId, id);
      if (!run || !['cleanup', 'daily'].includes(run.kind)) throw new Error('Cleanup run not found.');
      const changes = await this.store.all(
        "SELECT * FROM changes WHERE run_id=? AND account_id=? AND status IN ('applied','uncertain','undo_uncertain')",
        runId,
        id
      );
      if (!changes.length)
        throw new Error('There are no remaining changes to undo. Cleanups can be undone for 30 days.');
      const gmail = this.client(await this.account(id));
      let restored = 0;
      for (const row of changes) {
        await guard();
        const change = this.crypto.open(row.payload);
        const message = await metadata(gmail, row.message_id);
        const inverse = undoChanges(change);
        // Undo only labels actually touched by this run; unrelated labels survive.
        const body = {
          addLabelIds: inverse.addLabelIds.filter(l => !message.labelIds?.includes(l)),
          removeLabelIds: inverse.removeLabelIds.filter(l => message.labelIds?.includes(l))
        };
        await this.store.run("UPDATE changes SET status='undo_uncertain' WHERE id=?", row.id);
        if (body.addLabelIds.length || body.removeLabelIds.length)
          await gmail(`messages/${encodeURIComponent(row.message_id)}/modify`, body);
        await this.store.run("UPDATE changes SET status='undone' WHERE id=?", row.id);
        restored++;
      }
      await this.store.run("UPDATE runs SET status='undone' WHERE id=?", runId);
      return { restored };
    });
  }
  async unsubscribe(id, sender, post = postUnsubscribe) {
    return this.locked(id, async () => {
      const row = await this.store.get('SELECT * FROM subscriptions WHERE account_id=? AND sender=?', id, sender);
      if (!row || row.status !== 'review')
        throw new Error('This subscription needs manual review, or a request was already submitted.');
      const gmail = this.client(await this.account(id));
      const message = await metadata(gmail, row.message_id);
      const headers = headersOf(message);
      if (senderAddress(headers.from) !== sender) throw new Error('Sender changed. Find subscriptions again.');
      const url = unsubscribeUrl(headers);
      if (!url || url.hostname !== row.host)
        throw new Error('One-click unsubscribe is no longer available. Review this sender in Gmail.');
      await this.store.run("UPDATE subscriptions SET status='uncertain' WHERE account_id=? AND sender=?", id, sender);
      try {
        await post(url);
        await this.store.run("UPDATE subscriptions SET status='requested' WHERE account_id=? AND sender=?", id, sender);
        await this.store.run(
          "INSERT INTO runs(id,account_id,kind,status,total,detail,created) VALUES(?,?,'unsubscribe','requested',1,?,?)",
          randomUUID(),
          id,
          `Request accepted for ${sender}. The sender may take time to stop mail.`,
          Date.now()
        );
        return { status: 'requested' };
      } catch (error) {
        throw new Error(`${error.message} Request status is uncertain; it will not be retried automatically.`);
      }
    });
  }
  // Remove only data nothing reads again. Holds, assessments and uncertain
  // changes stay: they stop the agent from re-touching or re-billing a message.
  async prune(now = Date.now()) {
    // Only agent logs remain in plans; this clears rows left by the removed preview flow.
    await this.store.run("DELETE FROM plans WHERE status<>'agent_log'");
    await this.store.run(
      `DELETE FROM plans WHERE status='agent_log' AND id NOT IN (SELECT id FROM plans p WHERE p.account_id=plans.account_id AND p.status='agent_log' ORDER BY p.created DESC LIMIT ${AGENT_LOGS_KEPT})`
    );
    // Past the undo window, keep the row (message id) but drop the label payload.
    await this.store.run(
      "UPDATE changes SET status='expired',payload='' WHERE status IN ('applied','undone') AND created<?",
      now - UNDO_WINDOW
    );
    await this.store.run('DELETE FROM preference_events WHERE created<?', now - PREFERENCE_EVENT_RETENTION);
  }
  async daily() {
    for (const row of await this.store.all('SELECT id,rules,last_day FROM accounts')) {
      const rules = JSON.parse(row.rules);
      // Only the agent runs on a schedule; an account without it set up is skipped, not claimed.
      if (
        !rules.daily ||
        !rules.agent?.enabled ||
        dailyIsPaused(rules) ||
        !(await accessFor(this, row.id)).dailyAllowed
      )
        continue;
      const day = dailyKey(rules);
      // Keys sort in time order, so a later or equal claim means this run already happened.
      if (!day || (row.last_day && row.last_day >= day)) continue;
      try {
        await this.locked(row.id, async guard => {
          const latest = await this.store.get('SELECT last_day,rules FROM accounts WHERE id=?', row.id);
          if (
            !latest ||
            (latest.last_day && latest.last_day >= day) ||
            !JSON.parse(latest.rules).daily ||
            !JSON.parse(latest.rules).agent?.enabled ||
            dailyIsPaused(JSON.parse(latest.rules))
          )
            return;
          // Claim each scheduled run once; interrupted/failed mutations require manual review.
          await this.store.run('UPDATE accounts SET last_day=?,last_error=NULL WHERE id=?', day, row.id);
          await this.runAgent(this, row.id, guard, undefined, 'daily');
        });
      } catch (error) {
        await this.store.run('UPDATE accounts SET last_error=? WHERE id=?', error.message, row.id);
      }
    }
  }
}
