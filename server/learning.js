import { createHash, randomUUID } from 'node:crypto';
import { headersOf, senderAddress } from './rules.js';
import { PREFERENCE_CATEGORIES, categoryScope, discoveryModelKey } from './preference-categories.js';

export const ASK_PREFERENCE_TOOL = {
  type: 'function', function: { name: 'ask_preference', description: 'Ask one broad category preference that applies across products and senders. Never ask whether the user wants a specific brand or mailing list. Reuse existing category preferences; sender exceptions are managed separately by the user. The email stays unchanged. The server supplies canonical wording and permitted choices. Never wait for an answer.', parameters: { type: 'object', additionalProperties: false, properties: { category: { type: 'string', enum: Object.keys(PREFERENCE_CATEGORIES) }, question: { type: 'string', maxLength: 240 }, reason: { type: 'string', maxLength: 400 } }, required: ['category', 'question', 'reason'] } }
};
export function scopeFor(message) {
  const h = headersOf(message); const sender = senderAddress(h.from);
  const listId = h['list-id']?.match(/<([^<>\s]+)>/)?.[1]?.toLowerCase() || '';
  return { sender, listId, scopeHash: createHash('sha256').update(JSON.stringify({ sender, listId })).digest('hex') };
}
export function choicesFor(p, scope) {
  const labels = { read: 'Mark future low-priority mail as read', archive: 'Archive future low-priority mail', both: 'Mark read and archive future low-priority mail' };
  return [{ id: 'keep', label: scope.kind === 'category' ? 'Keep these in my inbox' : 'Always keep this sender or list' }, { id: p.action, label: labels[p.action] }, ...(p.autoUnsubscribe && scope.listId ? [{ id: 'unsubscribe', label: 'Unsubscribe from future unwanted marketing on this list' }] : []), { id: 'later', label: 'Ask me tomorrow; leave emails alone' }];
}
export async function memoryFor(service, id, scope) {
  const row = await service.store.get('SELECT id,payload,version FROM preference_memories WHERE account_id=? AND scope_hash=?', id, scope.scopeHash);
  return row ? { id: row.id, version: row.version, ...service.crypto.open(row.payload) } : null;
}
export async function categoryContext(service, id) {
  const [memories, questions] = await Promise.all([
    service.store.all("SELECT id,payload,version FROM preference_memories WHERE account_id=? AND scope_hash LIKE 'category:%'", id),
    service.store.all("SELECT id,scope_hash FROM agent_questions WHERE account_id=? AND status='pending' AND scope_hash LIKE 'category:%'", id)
  ]);
  return { memories: memories.map(r => ({ id: r.id, version: r.version, ...service.crypto.open(r.payload) })), questions };
}
export async function holdEmail(service, id, messageId, scope, questionId = null) {
  await service.store.run('INSERT INTO agent_holds(account_id,message_id,scope_hash,question_id,created) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING', id, messageId, scope.scopeHash, questionId, Date.now());
}
export async function askPreference(service, id, message, p, args) {
  if (!args || !categoryScope(args.category) || typeof args.question !== 'string' || !args.question.trim() || args.question.length > 240 || typeof args.reason !== 'string' || args.reason.length > 400 || Object.keys(args).some(k => !['category','question','reason'].includes(k))) throw new Error('Invalid preference question. Email was left unchanged.');
  const scope = categoryScope(args.category); const now = Date.now();
  const result = await service.store.transaction(async tx => {
    const old = await tx.get('SELECT id,status FROM agent_questions WHERE account_id=? AND scope_hash=?', id, scope.scopeHash);
    if (old && ['pending', 'dismissed'].includes(old.status)) return { id: old.id, status: old.status };
    const memory = await tx.get('SELECT id FROM preference_memories WHERE account_id=? AND scope_hash=?', id, scope.scopeHash);
    if (memory) return { id: old?.id || null, status: 'already_learned' };
    const questionId = old?.id || randomUUID();
    const payload = service.crypto.seal({ question: PREFERENCE_CATEGORIES[args.category].question, reason: args.reason, scope, options: choicesFor(p, scope), sample: { subject: headersOf(message).subject || '(No subject)' } });
    if (old) await tx.run("UPDATE agent_questions SET payload=?,status='pending',version=version+1,updated=?,deferred_at=?,snoozed_until=0 WHERE id=? AND account_id=?", payload, now, now + 30000, questionId, id);
    else await tx.run("INSERT INTO agent_questions(id,account_id,scope_hash,payload,status,created,updated,deferred_at) VALUES(?,?,?,?,'pending',?,?,?)", questionId, id, scope.scopeHash, payload, now, now, now + 30000);
    return { id: questionId, status: 'pending' };
  });
  await holdEmail(service, id, message.id, scope, result.id);
  return { tool: 'ask_preference', ...result, outcome: 'email_held', waitsForUser: false };
}
export async function learningTray(service, id) {
  const [questions, memories, discovery, pending] = await Promise.all([
    service.store.all("SELECT id,payload,version,created,deferred_at FROM agent_questions WHERE account_id=? AND status='pending' AND scope_hash LIKE 'category:%' AND snoozed_until<=? ORDER BY created LIMIT 20", id, Date.now()),
    service.store.all('SELECT id,payload,version,updated FROM preference_memories WHERE account_id=? ORDER BY updated DESC LIMIT 200', id),
    service.store.get('SELECT payload FROM agent_discoveries WHERE account_id=? AND provider=? AND model=?', id, service.config.aiProvider || 'openrouter', discoveryModelKey(service.config.aiModel)),
    service.store.get("SELECT count(*) AS total FROM agent_questions WHERE account_id=? AND status='pending' AND scope_hash LIKE 'category:%' AND snoozed_until<=?", id, Date.now())
  ]);
  return { questions: questions.map(({ payload, ...row }) => ({ ...row, ...service.crypto.open(payload) })), questionsTotal: pending.total, memories: memories.map(({ payload, ...row }) => ({ ...row, ...service.crypto.open(payload) })), discovery: discovery ? service.crypto.open(discovery.payload) : null };
}
async function recordEvent(tx, service, id, data) { await tx.run('INSERT INTO preference_events(id,account_id,payload,created) VALUES(?,?,?,?)', randomUUID(), id, service.crypto.seal(data), Date.now()); }
export async function answerPreference(service, id, input) {
  return service.locked(id, async () => service.store.transaction(async tx => {
    const row = await tx.get("SELECT * FROM agent_questions WHERE id=? AND account_id=? AND status='pending'", input.questionId, id);
    if (!row || input.version !== row.version) throw new Error('Question changed or was already answered. Reload the tray.');
    const question = service.crypto.open(row.payload);
    if (!question.options.some(o => o.id === input.option)) throw new Error('Choose one of the offered answers.');
    if (input.option === 'later') {
      await tx.run('UPDATE agent_questions SET snoozed_until=?,updated=?,version=version+1 WHERE id=? AND account_id=?', Date.now() + 86400000, Date.now(), row.id, id);
      return { status: 'snoozed' };
    }
    const memory = { scope: question.scope, action: input.option, sourceQuestion: row.id, explanation: question.question, applies: 'future_messages_only', effectiveFrom: Date.now() };
    await tx.run('INSERT INTO preference_memories(id,account_id,scope_hash,payload,updated) VALUES(?,?,?,?,?) ON CONFLICT(account_id,scope_hash) DO UPDATE SET payload=excluded.payload,version=preference_memories.version+1,updated=excluded.updated', randomUUID(), id, row.scope_hash, service.crypto.seal(memory), Date.now());
    await tx.run("UPDATE agent_questions SET status='answered',version=version+1,updated=? WHERE id=? AND account_id=?", Date.now(), row.id, id);
    await recordEvent(tx, service, id, { kind: 'answer', questionId: row.id, memory });
    return { status: 'saved', applies: 'future_messages_only' };
  }));
}
export async function editMemory(service, id, input) {
  return service.locked(id, async () => service.store.transaction(async tx => {
    const row = await tx.get('SELECT * FROM preference_memories WHERE id=? AND account_id=?', input.memoryId, id);
    if (!row || row.version !== input.version) throw new Error('Preference changed. Reload before editing.');
    const memory = service.crypto.open(row.payload);
    if (input.remove === true) {
      await tx.run('DELETE FROM preference_memories WHERE id=? AND account_id=?', row.id, id);
      await recordEvent(tx, service, id, { kind: 'remove', memoryId: row.id, memory }); return { status: 'removed' };
    }
    if (!['keep', 'read', 'archive', 'both', 'unsubscribe'].includes(input.action) || (input.action === 'unsubscribe' && !memory.scope.listId)) throw new Error('Choose a supported preference.');
    const previous = memory.action; memory.action = input.action; memory.effectiveFrom = Date.now();
    await tx.run('UPDATE preference_memories SET payload=?,version=version+1,updated=? WHERE id=? AND account_id=?', service.crypto.seal(memory), Date.now(), row.id, id);
    await recordEvent(tx, service, id, { kind: 'edit', memoryId: row.id, previous, memory });
    return { status: 'saved', applies: 'future_messages_only' };
  }));
}
