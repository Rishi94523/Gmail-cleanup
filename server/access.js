import { createHash } from 'node:crypto';
import { PRIMARY_INBOX_QUERY } from './inbox-scope.js';

export const FREE_EMAIL_LIMIT = 100;
const key = value => createHash('sha256').update(value).digest('hex');
export const TRIAL_REPAIR_VERSION = 'body-discovery-batches-v2';
export async function accessFor(service, id) {
  if (service.config.hackathonMode)
    return {
      tier: 'hackathon',
      limit: 100,
      used: 0,
      remaining: 100,
      dailyAllowed: true,
      discoveryUsed: false,
      recoveryAvailable: false,
      recovering: false
    };
  const accountKey = key(id);
  await service.store.run(
    "INSERT INTO account_access(account_key,tier,free_used,discovery_used) VALUES(?,'free',0,0) ON CONFLICT DO NOTHING",
    accountKey
  );
  const row = await service.store.get(
    'SELECT tier,free_used,discovery_used FROM account_access WHERE account_key=?',
    accountKey
  );
  const trial =
    row.tier === 'free' && row.free_used
      ? await service.store.get('SELECT payload FROM trial_samples WHERE account_id=?', id)
      : null;
  const sample = trial ? service.crypto.open(trial.payload) : null;
  const recovering = Boolean(sample?.repair?.active);
  const recoveryAvailable = Boolean(
    sample &&
    !sample.repair &&
    (await service.store.get('SELECT count(*) AS total FROM changes WHERE account_id=?', id)).total === 0 &&
    (await service.store.get("SELECT count(*) AS total FROM runs WHERE account_id=? AND status='running'", id))
      .total === 0 &&
    (
      await service.store.get(
        "SELECT count(*) AS total FROM runs WHERE account_id=? AND status IN ('completed','needs_review')",
        id
      )
    ).total > 0
  );
  return {
    tier: row.tier,
    limit: FREE_EMAIL_LIMIT,
    used: row.free_used,
    remaining: recovering
      ? sample.ids.filter(id => !sample.repair.claimed.includes(id)).length
      : Math.max(0, FREE_EMAIL_LIMIT - row.free_used),
    dailyAllowed: row.tier === 'paid',
    discoveryUsed: Boolean(row.discovery_used),
    recoveryAvailable,
    recovering
  };
}
// A single explicit repair of the original sample after a zero-change run.
// Lifetime free usage is never reset, and an uncertain/applied write disqualifies it.
export async function restartTrial(service, id, authorized) {
  if (authorized !== true)
    throw new Error('Authorize reassessing the original sample, including previously held emails.');
  const access = await accessFor(service, id);
  if (!access.recoveryAvailable || access.tier !== 'free') throw new Error('A trial reassessment is not available.');
  return service.store.transaction(async tx => {
    const row = await tx.get('SELECT payload FROM trial_samples WHERE account_id=?', id);
    const sample = service.crypto.open(row.payload);
    sample.repair = { version: TRIAL_REPAIR_VERSION, active: true, claimed: [], discoveryClaimed: false };
    await tx.run('UPDATE trial_samples SET payload=? WHERE account_id=?', service.crypto.seal(sample), id);
    await tx.run('DELETE FROM agent_discoveries WHERE account_id=?', id);
    // The user is explicitly revisiting these held messages, rather than a later
    // answer silently authorizing work on a previously deferred email.
    await tx.run('DELETE FROM agent_holds WHERE account_id=?', id);
    for (const question of await tx.all(
      "SELECT id,payload FROM agent_questions WHERE account_id=? AND status='pending'",
      id
    )) {
      const payload = service.crypto.open(question.payload);
      payload.initial = true;
      await tx.run(
        'UPDATE agent_questions SET payload=?,snoozed_until=0,version=version+1 WHERE id=?',
        service.crypto.seal(payload),
        question.id
      );
    }
    return { status: 'ready', sampleCount: sample.ids.length };
  });
}
export async function requirePaid(service, id) {
  if (!(await accessFor(service, id)).dailyAllowed)
    throw new Error('Daily and additional cleanups require a paid plan. Your free cleanup covers up to 100 emails.');
}
export async function trialSample(service, id, gmail) {
  const previous = await service.store.get('SELECT payload FROM trial_samples WHERE account_id=?', id);
  if (previous) return service.crypto.open(previous.payload);
  const page = await gmail(
    `messages?${new URLSearchParams({ q: PRIMARY_INBOX_QUERY, maxResults: String(FREE_EMAIL_LIMIT) })}`
  );
  const ids = [...new Set((page.messages || []).map(m => m.id))].slice(0, FREE_EMAIL_LIMIT);
  const sample = { ids, scope: 'primary', moreAvailable: Boolean(page.nextPageToken), created: Date.now() };
  await service.store.run(
    'INSERT INTO trial_samples(account_id,payload) VALUES(?,?) ON CONFLICT DO NOTHING',
    id,
    service.crypto.seal(sample)
  );
  return sample;
}
export async function reserveDiscovery(service, id) {
  const row = await service.store.get('SELECT payload FROM trial_samples WHERE account_id=?', id);
  if (row) {
    const sample = service.crypto.open(row.payload);
    if (sample.repair?.active && !sample.repair.discoveryClaimed) {
      sample.repair.discoveryClaimed = true;
      await service.store.run('UPDATE trial_samples SET payload=? WHERE account_id=?', service.crypto.seal(sample), id);
      return true;
    }
  }
  return (
    (
      await service.store.run(
        'UPDATE account_access SET discovery_used=1 WHERE account_key=? AND discovery_used=0',
        key(id)
      )
    ).changes === 1
  );
}
// Reserve before contacting Gmail/the model. Ambiguous failures never replay a
// paid inference for a free message, even after preference changes or reconnects.
export async function reserveFreeEmail(service, id, messageId, recovery = false) {
  return service.store.transaction(async tx => {
    if (recovery) {
      await tx.run('UPDATE trial_samples SET payload=payload WHERE account_id=?', id);
      const row = await tx.get('SELECT payload FROM trial_samples WHERE account_id=?', id);
      const sample = row && service.crypto.open(row.payload);
      if (
        !sample?.repair?.active ||
        !sample.ids.includes(messageId) ||
        sample.repair.claimed.includes(messageId) ||
        (await tx.get('SELECT count(*) AS total FROM changes WHERE account_id=? AND message_id=?', id, messageId)).total
      )
        return false;
      sample.repair.claimed.push(messageId);
      await tx.run('UPDATE trial_samples SET payload=? WHERE account_id=?', service.crypto.seal(sample), id);
      const used = await tx.get(
        'SELECT message_key FROM free_email_usage WHERE account_key=? AND message_key=?',
        key(id),
        key(messageId)
      );
      if (!used) {
        const claimed = await tx.run(
          'UPDATE account_access SET free_used=free_used+1 WHERE account_key=? AND free_used<?',
          key(id),
          FREE_EMAIL_LIMIT
        );
        if (!claimed.changes) throw new Error('Free sample usage is inconsistent; reassessment stopped.');
        await tx.run('INSERT INTO free_email_usage(account_key,message_key) VALUES(?,?)', key(id), key(messageId));
      }
      return true;
    }
    const old = await tx.get(
      'SELECT message_key FROM free_email_usage WHERE account_key=? AND message_key=?',
      key(id),
      key(messageId)
    );
    if (old) return false;
    const claimed = await tx.run(
      'UPDATE account_access SET free_used=free_used+1 WHERE account_key=? AND free_used<?',
      key(id),
      FREE_EMAIL_LIMIT
    );
    if (!claimed.changes) return false;
    await tx.run('INSERT INTO free_email_usage(account_key,message_key) VALUES(?,?)', key(id), key(messageId));
    return true;
  });
}
