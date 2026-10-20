import { createHash, randomUUID } from 'node:crypto';
import { headersOf, senderAddress } from './rules.js';
import { PREFERENCE_CATEGORIES, categoryScope, discoveryModelKey } from './preference-categories.js';
import { chatJSON } from './ai.js';
import { clockContext } from './email-context.js';

export const QUESTION_EXPLANATION_GUIDANCE = '\nWrite every question reason for the person using the app: one or two short, natural sentences describing the actual inbox pattern and why their choice matters. For example: "You receive activity alerts, including mention notifications from Academia.edu. Your answer will help me handle similar alerts." This is a style example only; use only senders and patterns actually present. Never expose category keys, missing preferences, confidence scores, schemas, or other implementation details. Do not call social-platform notifications cold outreach merely because they are unwanted; cold outreach means direct unsolicited pitches or business approaches. Keep the question broad across senders.';

export function questionExplanation(reason, scope, sample) {
  // Older stored questions may contain model diagnostics. Keep their actual
  // subject as evidence rather than paying for another inference to rewrite it.
  if (/\b[a-z]+(?:_[a-z]+)+\b|category preference|no .*preference.*exist|missing preference|categoryConfidence|scope_hash/i.test(reason || '')) {
    return `Your inbox includes ${scope.label.toLowerCase()}${sample.subject && sample.subject !== '(No subject)' ? `, such as “${sample.subject.slice(0, 160)}”` : ''}. Your answer will guide how similar emails are handled.`;
  }
  return reason;
}
async function initialSamplePending(service, id, store = service.store) {
  if (service.config.hackathonMode) return !(await store.get("SELECT count(*) AS total FROM runs WHERE account_id=? AND kind IN ('cleanup','daily')", id)).total;
  const row = await store.get('SELECT payload FROM trial_samples WHERE account_id=?', id);
  const sample = row && service.crypto.open(row.payload);
  if (sample?.repair?.active) return sample.repair.claimed.length === 0;
  const access = await store.get('SELECT free_used FROM account_access WHERE account_key=?', createHash('sha256').update(id).digest('hex'));
  return !access?.free_used;
}

export const ASK_PREFERENCE_TOOL = {
  type: 'function', function: { name: 'ask_preference', description: 'Ask one broad category preference that applies across products and senders. Never ask whether the user wants a specific brand or mailing list. Reuse existing category preferences; sender exceptions are managed separately by the user. The email stays unchanged. Explain the observed inbox pattern in plain, natural language for the user; never mention internal category keys or missing preferences. Use a broad reusable topic; examples include job alerts or newsletters, but invent a topic_ slug when the actual email needs a different topic. The server supplies permitted choices. Never wait for an answer.', parameters: { type: 'object', additionalProperties: false, properties: { category: { type: 'string', pattern: '^(?:' + Object.keys(PREFERENCE_CATEGORIES).join('|') + '|topic_[a-z][a-z0-9_]{2,48})$' }, question: { type: 'string', maxLength: 240 }, reason: { type: 'string', maxLength: 400 }, minAgeDays: { type: 'integer', minimum: 0, maximum: 3650 } }, required: ['category', 'question', 'reason'] } }
};
export function scopeFor(message) {
  const h = headersOf(message); const sender = senderAddress(h.from);
  const listId = h['list-id']?.match(/<([^<>\s]+)>/)?.[1]?.toLowerCase() || '';
  return { sender, listId, scopeHash: createHash('sha256').update(JSON.stringify({ sender, listId })).digest('hex') };
}
export function choicesFor(p, scope) {
  const labels = { read: 'Mark as read', archive: 'Archive', both: 'Mark as read and archive' };
  return [{ id: 'keep', label: scope.kind === 'category' ? 'Keep these in my inbox' : 'Always keep this sender or list' }, ...(p.topicActions && scope.kind === 'category' ? Object.entries(labels).map(([id, label]) => ({ id, label })) : [{ id: p.action, label: labels[p.action] }]), ...(p.autoUnsubscribe && scope.listId ? [{ id: 'unsubscribe', label: 'Unsubscribe from future unwanted marketing on this list' }] : []), { id: 'later', label: 'Ask me tomorrow; leave emails alone' }];
}
export async function memoryFor(service, id, scope) {
  const row = await service.store.get('SELECT id,payload,version FROM preference_memories WHERE account_id=? AND scope_hash=?', id, scope.scopeHash);
  return row ? { id: row.id, version: row.version, ...service.crypto.open(row.payload) } : null;
}
export async function categoryContext(service, id) {
  const [memories, questions, notes] = await Promise.all([
    service.store.all("SELECT id,payload,version FROM preference_memories WHERE account_id=? AND scope_hash LIKE 'category:%'", id),
    service.store.all("SELECT id,scope_hash FROM agent_questions WHERE account_id=? AND status='pending' AND scope_hash LIKE 'category:%'", id),
    service.store.all("SELECT payload FROM preference_memories WHERE account_id=? AND scope_hash LIKE 'note:%' ORDER BY updated", id)
  ]);
  return { memories: memories.map(r => ({ id: r.id, version: r.version, ...service.crypto.open(r.payload) })), questions, notes: notes.map(r => service.crypto.open(r.payload).instructions) };
}
export async function holdEmail(service, id, messageId, scope, questionId = null) {
  await service.store.run('INSERT INTO agent_holds(account_id,message_id,scope_hash,question_id,created) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING', id, messageId, scope.scopeHash, questionId, Date.now());
}
function preferenceAge(value, scope, fallback = 0) {
  const days = value ?? fallback; const floor = categoryScope(scope.category)?.minimumAgeDays || 0;
  if (!Number.isInteger(days) || days < floor || days > 3650) throw new Error(`Choose an age of ${floor} to 3650 days for this topic.`);
  return days;
}
export async function askPreference(service, id, message, p, args, { initial = false, authored = false } = {}) {
  if (!args || !categoryScope(args.category) || typeof args.question !== 'string' || !args.question.trim() || args.question.length > 240 || typeof args.reason !== 'string' || args.reason.length > 400 || Object.keys(args).some(k => !['category','question','reason','minAgeDays'].includes(k))) throw new Error('Invalid preference question. Email was left unchanged.');
  const scope = categoryScope(args.category); const now = Date.now();
  const minAgeDays = preferenceAge(Math.max(args.minAgeDays ?? 0, scope.minimumAgeDays || 0), scope);
  const result = await service.store.transaction(async tx => {
    const old = await tx.get('SELECT id,status FROM agent_questions WHERE account_id=? AND scope_hash=?', id, scope.scopeHash);
    if (old && ['pending', 'dismissed'].includes(old.status)) return { id: old.id, status: old.status };
    const memory = await tx.get('SELECT id FROM preference_memories WHERE account_id=? AND scope_hash=?', id, scope.scopeHash);
    if (memory) return { id: old?.id || null, status: 'already_learned' };
    const questionId = old?.id || randomUUID();
    const fallback = PREFERENCE_CATEGORIES[args.category]?.question || `How should I handle ${scope.label.toLowerCase()}?`;
    // The model chooses topics and evidence; category wording keeps questions
    // broad instead of letting a cited sender turn into a brand-specific rule.
    const wording = authored || minAgeDays ? `How should I handle ${scope.label.toLowerCase()}${minAgeDays ? ` older than ${minAgeDays} days` : ''}?` : fallback;
    const sample = { subject: headersOf(message).subject || '(No subject)' };
    const payload = service.crypto.seal({ question: wording, reason: questionExplanation(args.reason, scope, sample), scope, initial, minAgeDays, options: choicesFor(p, scope), sample });
    if (old) await tx.run("UPDATE agent_questions SET payload=?,status='pending',version=version+1,updated=?,deferred_at=?,snoozed_until=0 WHERE id=? AND account_id=?", payload, now, now + 30000, questionId, id);
    else await tx.run("INSERT INTO agent_questions(id,account_id,scope_hash,payload,status,created,updated,deferred_at) VALUES(?,?,?,?,'pending',?,?,?)", questionId, id, scope.scopeHash, payload, now, now, now + 30000);
    return { id: questionId, status: 'pending' };
  });
  if (!initial) await holdEmail(service, id, message.id, scope, result.id);
  return { tool: 'ask_preference', ...result, outcome: 'email_held', waitsForUser: false };
}
export async function learningTray(service, id) {
  const [questions, memories, discovery, pending] = await Promise.all([
    service.store.all("SELECT id,payload,version,created,deferred_at FROM agent_questions WHERE account_id=? AND status='pending' AND scope_hash LIKE 'category:%' AND snoozed_until<=? ORDER BY created LIMIT 20", id, Date.now()),
    service.store.all('SELECT id,payload,version,updated FROM preference_memories WHERE account_id=? ORDER BY updated DESC LIMIT 200', id),
    service.store.get('SELECT payload FROM agent_discoveries WHERE account_id=? AND provider=? AND model=?', id, service.config.aiProvider || 'nebius', discoveryModelKey(service.config.aiModel)),
    service.store.get("SELECT count(*) AS total FROM agent_questions WHERE account_id=? AND status='pending' AND scope_hash LIKE 'category:%' AND snoozed_until<=?", id, Date.now())
  ]);
  const initialPending = await initialSamplePending(service, id);
  const actionLabels = { read: 'Mark as read', archive: 'Archive', both: 'Mark as read and archive' };
  return { questions: questions.map(({ payload, ...row }) => {
    const question = service.crypto.open(payload);
    return { ...row, ...question, initial: Boolean(question.initial && initialPending), reason: questionExplanation(question.reason, question.scope, question.sample), options: question.options.map(option => ({ ...option, label: actionLabels[option.id] || option.label })) };
  }), questionsTotal: pending.total, memories: memories.map(({ payload, ...row }) => ({ ...row, ...service.crypto.open(payload) })), discovery: discovery ? service.crypto.open(discovery.payload) : null };
}
async function recordEvent(tx, service, id, data) { await tx.run('INSERT INTO preference_events(id,account_id,payload,created) VALUES(?,?,?,?)', randomUUID(), id, service.crypto.seal(data), Date.now()); }
export async function interpretPreference(service, id, input) {
  const account = await service.account(id);
  if (!account.rules.agent?.consent || account.rules.agent.consentProvider !== (service.config.aiProvider || 'nebius')) throw new Error('Allow AI processing for the selected provider first.');
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 2000) throw new Error('Write an answer of 1 to 2000 characters.');
  const row = await service.store.get("SELECT id,payload,version FROM agent_questions WHERE id=? AND account_id=? AND status='pending'", input.questionId, id);
  if (!row || row.version !== input.version) throw new Error('Question changed. Reload before answering.');
  const question = service.crypto.open(row.payload);
  const allowed = question.options.map(option => option.id).filter(action => ['keep','read','archive','both'].includes(action));
  const result = await chatJSON(service.config, [{ role: 'system', content: 'Interpret the user-written answer to one inbox preference question. Propose only an explicitly requested allowed action and an age in whole days. Do not invent permissions from a vague answer. Preserve conditions and exceptions in the original answer; do not claim they can override protected labels, recent sensitive notices, medical/legal mail, or unresolved fraud/security issues. Never delete, trash, send or unsubscribe. If the answer requests unsupported actions, contradicts itself, lacks an action, or cannot be represented by one topic action plus an age threshold and written conditions, return JSON {"supported":false,"clarification":"one short question or explanation"}. Otherwise return JSON {"supported":true,"action":"keep|read|archive|both","minAgeDays":0}. The user will see and confirm the proposal before it is saved. No email changes are authorized by this interpretation.' }, { role: 'user', content: JSON.stringify({ question: question.question, category: question.scope.category, allowedActions: allowed, minimumAgeDays: question.scope.minimumAgeDays || 0, suggestedMinAgeDays: question.minAgeDays || 0, clock: clockContext(account.rules.timezone), answer: input.text.trim() }) }]);
  if (result.supported !== true) return { supported: false, clarification: typeof result.clarification === 'string' ? result.clarification.slice(0, 300) : 'Please specify keep, mark read, archive, or both, and any age threshold.' };
  if (!allowed.includes(result.action)) throw new Error('AI proposed an action outside this question’s choices. Please clarify your answer.');
  const minAgeDays = preferenceAge(result.minAgeDays, question.scope, question.minAgeDays || 0);
  return { supported: true, action: result.action, minAgeDays, instructions: input.text.trim() };
}
export async function answerPreference(service, id, input) {
  return service.locked(id, async () => service.store.transaction(async tx => {
    const row = await tx.get("SELECT * FROM agent_questions WHERE id=? AND account_id=? AND status='pending'", input.questionId, id);
    if (!row || input.version !== row.version) throw new Error('Question changed or was already answered. Reload the tray.');
    const question = service.crypto.open(row.payload);
    const custom = input.option === 'custom'; const action = custom ? input.action : input.option;
    if (!question.options.some(o => o.id === action) || (custom && !['keep','read','archive','both'].includes(action))) throw new Error('Choose one of the offered answers.');
    if (custom && (typeof input.instructions !== 'string' || !input.instructions.trim() || input.instructions.length > 2000)) throw new Error('Write an answer of 1 to 2000 characters.');
    if (input.option === 'later') {
      await tx.run('UPDATE agent_questions SET snoozed_until=?,updated=?,version=version+1 WHERE id=? AND account_id=?', Date.now() + 86400000, Date.now(), row.id, id);
      return { status: 'snoozed' };
    }
    const minAgeDays = preferenceAge(custom ? input.minAgeDays : undefined, question.scope, question.minAgeDays || question.scope.minimumAgeDays || 0);
    const memory = { scope: question.scope, action, minAgeDays, instructions: custom ? input.instructions.trim() : '', sourceQuestion: row.id, explanation: question.question, applies: 'future_messages_only', effectiveFrom: Date.now() };
    if (question.initial && await initialSamplePending(service, id, tx)) {
      const sample = await tx.get('SELECT payload FROM trial_samples WHERE account_id=?', id);
      if (sample) { memory.initialSampleIds = service.crypto.open(sample.payload).ids; memory.applies = 'initial_sample_and_future_messages'; }
    }
    await tx.run('INSERT INTO preference_memories(id,account_id,scope_hash,payload,updated) VALUES(?,?,?,?,?) ON CONFLICT(account_id,scope_hash) DO UPDATE SET payload=excluded.payload,version=preference_memories.version+1,updated=excluded.updated', randomUUID(), id, row.scope_hash, service.crypto.seal(memory), Date.now());
    await tx.run("UPDATE agent_questions SET status='answered',version=version+1,updated=? WHERE id=? AND account_id=?", Date.now(), row.id, id);
    await recordEvent(tx, service, id, { kind: 'answer', questionId: row.id, memory });
    return { status: 'saved', applies: memory.applies };
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
    if (memory.scope.kind === 'context' && input.action !== 'keep') throw new Error('Notes provide context only. Add a topic preference to authorize a cleanup action.');
    if (input.instructions !== undefined && (typeof input.instructions !== 'string' || input.instructions.length > 2000)) throw new Error('Keep written preferences under 2000 characters.');
    const minAgeDays = preferenceAge(input.minAgeDays, memory.scope, memory.minAgeDays || memory.scope.minimumAgeDays || 0);
    const previous = memory.action; memory.action = input.action; memory.minAgeDays = minAgeDays; if (input.instructions !== undefined) memory.instructions = input.instructions.trim(); memory.effectiveFrom = Date.now();
    await tx.run('UPDATE preference_memories SET payload=?,version=version+1,updated=? WHERE id=? AND account_id=?', service.crypto.seal(memory), Date.now(), row.id, id);
    await recordEvent(tx, service, id, { kind: 'edit', memoryId: row.id, previous, memory });
    return { status: 'saved', applies: 'future_messages_only' };
  }));
}

// Keep the preview bound to this account and preference versions. The browser
// confirms a sealed proposal, never supplies executable actions of its own.
async function preferenceSnapshot(service, id, store = service.store) {
  const rows = await store.all('SELECT id,version,payload FROM preference_memories WHERE account_id=? ORDER BY id', id);
  return { fingerprint: createHash('sha256').update(JSON.stringify(rows.map(r => [r.id, r.version]))).digest('hex'), memories: rows.map(r => ({ id: r.id, version: r.version, ...service.crypto.open(r.payload) })) };
}

export async function interpretNotes(service, id, input) {
  const account = await service.account(id);
  if (!account.rules.agent?.consent || account.rules.agent.consentProvider !== (service.config.aiProvider || 'nebius')) throw new Error('Allow AI processing before adding written preferences.');
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 2000) throw new Error('Write a preference of 1 to 2000 characters.');
  const text = input.text.trim(); const snapshot = await preferenceSnapshot(service, id);
  const result = await chatJSON(service.config, [{ role: 'system', content: 'Turn user-written inbox instructions into a preview for explicit confirmation. No email changes occur here. Return JSON {"supported":true,"topics":[{"category":"existing key or topic_new_broad_topic","action":"keep|read|archive|both","minAgeDays":0}],"context":true}. Set context=true only when the text contains background or interests worth remembering, otherwise false. Original user text is stored verbatim; do not paraphrase it. Use existing category keys for the same meaning. Standard topic examples are supplied, not mandatory. Create at most eight broad topic preferences across senders. Only propose an action the user explicitly requested; preserve every condition and sender exception in their original text, which will accompany each topic. Do not generalize a single-sender request into unconditional permission for a whole topic. Use topic-specific age thresholds, at least 30 days for routine bank transactions or login notices. Never authorize deletion, trash, sending, unsubscribe, disabling protections, or handling unresolved financial/security/medical/legal alerts. If vague, contradictory, unsupported, or requesting a change that needs clarification, return {"supported":false,"clarification":"one natural question"}; do not silently save only the supported portion. Background such as a job search may be saved as context without inventing cleanup permission. Context cannot authorize cleanup. Empty topics are allowed only when context=true.' }, { role: 'user', content: JSON.stringify({ text, clock: clockContext(account.rules.timezone), standardTopics: PREFERENCE_CATEGORIES, existing: snapshot.memories.map(m => ({ scope: m.scope, action: m.action, minAgeDays: m.minAgeDays, instructions: m.instructions })) }) }]);
  if (result.supported !== true) return { supported: false, clarification: typeof result.clarification === 'string' ? result.clarification.slice(0, 300) : 'What would you like kept, marked read, or archived?' };
  if (!Array.isArray(result.topics) || result.topics.length > 8) throw new Error('Please describe up to eight topics at a time.');
  const seen = new Set();
  const topics = result.topics.map(topic => {
    const scope = categoryScope(topic?.category);
    if (!scope || seen.has(scope.category) || !['keep', 'read', 'archive', 'both'].includes(topic.action)) throw new Error('The proposed preference needs clarification. Please try a more specific instruction.');
    seen.add(scope.category);
    return { scope, action: topic.action, minAgeDays: preferenceAge(topic.minAgeDays, scope), instructions: text };
  });
  const context = result.context === true || (typeof result.context === 'string' && result.context.trim()) ? text : '';
  if (!topics.length && !context) throw new Error('Describe a preference or something you want your agent to know.');
  if (context && snapshot.memories.filter(m => m.scope.kind === 'context').length >= 20) throw new Error('Edit or remove an existing note before adding another.');
  const proposal = { kind: 'preference_notes', accountId: id, fingerprint: snapshot.fingerprint, topics, context, expires: Date.now() + 20 * 60000 };
  return { supported: true, topics: topics.map(t => ({ ...t, replaces: snapshot.memories.some(m => m.scope.scopeHash === t.scope.scopeHash) })), context, token: service.crypto.seal(proposal) };
}

export async function saveNotes(service, id, input) {
  let proposal;
  try { proposal = service.crypto.open(input.token); } catch { throw new Error('Review your written preference again before saving.'); }
  if (proposal?.kind !== 'preference_notes' || proposal.accountId !== id || proposal.expires < Date.now()) throw new Error('This preview expired. Review your preference again.');
  return service.locked(id, async () => service.store.transaction(async tx => {
    const snapshot = await preferenceSnapshot(service, id, tx);
    if (snapshot.fingerprint !== proposal.fingerprint) throw new Error('Your preferences changed. Review your instructions again before saving.');
    const now = Date.now();
    const sample = await initialSamplePending(service, id, tx) && await tx.get('SELECT payload FROM trial_samples WHERE account_id=?', id);
    const initialSampleIds = sample ? service.crypto.open(sample.payload).ids : null;
    for (const topic of proposal.topics) {
      const memory = { ...topic, explanation: topic.scope.label, applies: initialSampleIds ? 'initial_sample_and_future_messages' : 'future_messages_only', effectiveFrom: now, ...(initialSampleIds ? { initialSampleIds } : {}) };
      await tx.run('INSERT INTO preference_memories(id,account_id,scope_hash,payload,updated) VALUES(?,?,?,?,?) ON CONFLICT(account_id,scope_hash) DO UPDATE SET payload=excluded.payload,version=preference_memories.version+1,updated=excluded.updated', randomUUID(), id, topic.scope.scopeHash, service.crypto.seal(memory), now);
      // Resolve the topic question, but do not release or replay held emails.
      await tx.run("UPDATE agent_questions SET status='answered',version=version+1,updated=? WHERE account_id=? AND scope_hash=? AND status='pending'", now, id, topic.scope.scopeHash);
      await recordEvent(tx, service, id, { kind: 'written_preference', memory });
    }
    if (proposal.context) {
      const memoryId = randomUUID(); const scopeHash = `note:${memoryId}`;
      const memory = { scope: { kind: 'context', label: 'A note for your agent', scopeHash }, action: 'keep', minAgeDays: 0, instructions: proposal.context, explanation: 'Context for future decisions; does not authorize cleanup.', effectiveFrom: now, applies: 'future_messages_only' };
      await tx.run('INSERT INTO preference_memories(id,account_id,scope_hash,payload,updated) VALUES(?,?,?,?,?)', memoryId, id, scopeHash, service.crypto.seal(memory), now);
      await recordEvent(tx, service, id, { kind: 'written_context', memory });
    }
    return { status: 'saved', applies: initialSampleIds ? 'initial_sample_and_future_messages' : 'future_messages_only' };
  }));
}
