import { randomUUID } from 'node:crypto';
import { headersOf, senderAddress } from './rules.js';
import { unsubscribeUrl, postUnsubscribe } from './security.js';
import { scopeFor } from './learning.js';
import { outsidePrimary } from './inbox-scope.js';

export function transactional(message) {
  const h = headersOf(message); const parts = [];
  function walk(part) { if (part?.mimeType === 'text/plain' && part.body?.data) parts.push(Buffer.from(part.body.data, 'base64url').toString('utf8').slice(0, 1500)); for (const child of part?.parts || []) walk(child); }
  walk(message.payload);
  const text = `${h.subject || ''} ${message.snippet || ''} ${parts.join(' ').slice(0, 1500)}`;
  return /\b(otp|one.time|verification|verif(y|ication)|authenticat\w*|password|security|receipt|invoice|payment|statement|order|refund|booking|reservation|medical|legal|tax)\b/i.test(text);
}
export function wantedPublication(message) {
  const h = headersOf(message);
  return /substack\.(com|net)|\b(newsletter|digest|blog|publication)\b/i.test(`${h.from || ''} ${h['list-id'] || ''} ${h.subject || ''}`);
}
export async function subscriptionEvidence(gmail, message) {
  const scope = scopeFor(message);
  if (!scope.listId || !unsubscribeUrl(headersOf(message))) return [];
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(scope.sender)) return [];
  const listed = await gmail(`messages?${new URLSearchParams({ q: `from:(${scope.sender}) -in:trash -in:spam`, maxResults: '5' })}`);
  const history = [message];
  for (const { id } of listed.messages || []) {
    if (id === message.id) continue;
    const item = await gmail(`messages/${encodeURIComponent(id)}?format=full`);
    if (scopeFor(item).scopeHash === scope.scopeHash) history.push(item);
  }
  return history.slice(0, 5);
}
export function unsubscribeEligible(raw, p, message, history, memory) {
  if (!p.autoUnsubscribe || raw?.action !== 'unsubscribe' || raw.emailType !== 'marketing' || typeof raw.confidence !== 'number' || raw.confidence < .995 || raw.confidence > 1) return false;
  if (memory?.action === 'keep' || (memory && memory.action !== 'unsubscribe' && memory.scope?.kind !== 'category') || (raw.subscriptionIntent !== 'unwanted' && memory?.action !== 'unsubscribe')) return false;
  if (!scopeFor(message).listId || !unsubscribeUrl(headersOf(message)) || history.length < 2 || history.some(transactional)) return false;
  if (history.some(wantedPublication) && memory?.action !== 'unsubscribe') return false;
  if (!Array.isArray(raw.historyTypes) || raw.historyTypes.length !== history.length) return false;
  return history.every(item => raw.historyTypes.filter(h => h.id === item.id && h.type === 'marketing').length === 1);
}
export async function automaticUnsubscribe(service, id, message, guard, expectedRules, post = postUnsubscribe) {
  const scope = scopeFor(message); const account = await service.account(id);
  if (!account.rules.agent?.autoUnsubscribe || JSON.stringify(account.rules) !== JSON.stringify(expectedRules) || transactional(message)) throw new Error('Unsubscribe permission or email context changed.');
  const gmail = service.client(account); const fresh = await gmail(`messages/${encodeURIComponent(message.id)}?format=metadata`);
  if (!fresh.labelIds?.includes('INBOX') || outsidePrimary(fresh) || fresh.historyId !== message.historyId || scopeFor(fresh).scopeHash !== scope.scopeHash || transactional(fresh)) throw new Error('Subscription changed; no unsubscribe request was sent.');
  const url = unsubscribeUrl(headersOf(fresh)); if (!url || !scope.listId) throw new Error('Supported one-click unsubscribe is not available.');
  const latest = await service.account(id);
  if (JSON.stringify(latest.rules) !== JSON.stringify(expectedRules)) throw new Error('Preferences changed; no unsubscribe request was sent.');
  await guard();
  const claimed = await service.store.run("INSERT INTO subscription_actions(account_id,list_key,message_id,status,created) VALUES(?,?,?,'uncertain',?) ON CONFLICT DO NOTHING", id, scope.scopeHash, message.id, Date.now());
  if (!claimed.changes) return { requested: false, reason: 'A request for this list was already submitted or needs checking' };
  const runId = randomUUID();
  await service.store.run("INSERT INTO runs(id,account_id,kind,status,total,detail,created) VALUES(?,?,'unsubscribe','needs_review',1,?,?)", runId, id, 'Automatic unsubscribe request reserved; completion unconfirmed. Do not retry automatically.', Date.now());
  await service.store.run("INSERT INTO subscriptions(account_id,sender,message_id,host,status) VALUES(?,?,?,?,'uncertain') ON CONFLICT(account_id,sender) DO UPDATE SET message_id=excluded.message_id,host=excluded.host,status='uncertain'", id, scope.sender, message.id, url.hostname);
  // Record before the external side effect; ambiguous requests are never replayed.
  await post(url);
  await service.store.run("UPDATE subscription_actions SET status='requested' WHERE account_id=? AND list_key=?", id, scope.scopeHash);
  await service.store.run("INSERT INTO subscriptions(account_id,sender,message_id,host,status) VALUES(?,?,?,?,'requested') ON CONFLICT(account_id,sender) DO UPDATE SET message_id=excluded.message_id,host=excluded.host,status='requested'", id, senderAddress(headersOf(fresh).from), message.id, url.hostname);
  await service.store.run("UPDATE runs SET status='requested',detail=? WHERE id=?", 'Agent submitted a request for an unwanted marketing list. This cannot be undone.', runId);
  return { requested: true, reason: 'Unsubscribe request submitted; sender confirmation may take time' };
}
