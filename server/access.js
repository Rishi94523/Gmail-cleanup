import { createHash } from 'node:crypto';

export const FREE_EMAIL_LIMIT = 100;
const key = value => createHash('sha256').update(value).digest('hex');
export async function accessFor(service, id) {
  const accountKey = key(id);
  await service.store.run("INSERT INTO account_access(account_key,tier,free_used,discovery_used) VALUES(?,'free',0,0) ON CONFLICT DO NOTHING", accountKey);
  const row = await service.store.get('SELECT tier,free_used,discovery_used FROM account_access WHERE account_key=?', accountKey);
  return { tier: row.tier, limit: FREE_EMAIL_LIMIT, used: row.free_used, remaining: Math.max(0, FREE_EMAIL_LIMIT - row.free_used), dailyAllowed: row.tier === 'paid', discoveryUsed: Boolean(row.discovery_used) };
}
export async function requirePaid(service, id) {
  if (!(await accessFor(service, id)).dailyAllowed) throw new Error('Daily and additional cleanups require a paid plan. Your free cleanup covers up to 100 emails.');
}
export async function trialSample(service, id, gmail) {
  const previous = await service.store.get('SELECT payload FROM trial_samples WHERE account_id=?', id);
  if (previous) return service.crypto.open(previous.payload);
  const page = await gmail(`messages?${new URLSearchParams({ q: 'in:inbox is:unread', maxResults: String(FREE_EMAIL_LIMIT) })}`);
  const ids = [...new Set((page.messages || []).map(m => m.id))].slice(0, FREE_EMAIL_LIMIT);
  const sample = { ids, moreAvailable: Boolean(page.nextPageToken), created: Date.now() };
  await service.store.run('INSERT INTO trial_samples(account_id,payload) VALUES(?,?) ON CONFLICT DO NOTHING', id, service.crypto.seal(sample));
  return sample;
}
export async function reserveDiscovery(service, id) {
  return (await service.store.run('UPDATE account_access SET discovery_used=1 WHERE account_key=? AND discovery_used=0', key(id))).changes === 1;
}
// Reserve before contacting Gmail/the model. Ambiguous failures never replay a
// paid inference for a free message, even after preference changes or reconnects.
export async function reserveFreeEmail(service, id, messageId) {
  return service.store.transaction(async tx => {
    const old = await tx.get('SELECT message_key FROM free_email_usage WHERE account_key=? AND message_key=?', key(id), key(messageId));
    if (old) return false;
    const claimed = await tx.run('UPDATE account_access SET free_used=free_used+1 WHERE account_key=? AND free_used<?', key(id), FREE_EMAIL_LIMIT);
    if (!claimed.changes) return false;
    await tx.run('INSERT INTO free_email_usage(account_key,message_key) VALUES(?,?)', key(id), key(messageId));
    return true;
  });
}
