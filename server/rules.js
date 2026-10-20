export const DEFAULT_RULES = Object.freeze({ days: 90, categories: ['promotions', 'social'], markRead: false, archive: true, protectedSenders: [], daily: false, dailyPausedUntil: 0, hour: 9, timezone: 'Asia/Kolkata', aiEnabled: false });
const categories = new Set(['promotions', 'social', 'updates']);
export function validateRules(input) {
  if (!input || !Number.isInteger(input.days) || input.days < 7 || input.days > 3650) throw new Error('Choose an age between 7 and 3650 days.');
  if (!Array.isArray(input.categories) || !input.categories.length || input.categories.some(c => !categories.has(c))) throw new Error('Choose at least one supported category.');
  if (!Array.isArray(input.protectedSenders) || input.protectedSenders.length > 100 || input.protectedSenders.some(s => typeof s !== 'string' || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(s))) throw new Error('Protected senders must be complete email addresses (up to 100).');
  if (![input.markRead, input.archive, input.daily, input.aiEnabled].every(x => typeof x === 'boolean') || (!input.archive && !input.markRead)) throw new Error('Choose archive, mark as read, or both.');
  if (!Number.isInteger(input.hour) || input.hour < 0 || input.hour > 23) throw new Error('Choose a valid daily hour.');
  if (typeof input.timezone !== 'string' || input.timezone.length > 100) throw new Error('Choose a valid timezone.');
  try { new Intl.DateTimeFormat('en', { timeZone: input.timezone }).format(); } catch { throw new Error('Choose a valid timezone.'); }
  const dailyPausedUntil = input.dailyPausedUntil ?? 0;
  if (!Number.isSafeInteger(dailyPausedUntil) || dailyPausedUntil < -1 || dailyPausedUntil > 8640000000000000) throw new Error('Choose a valid daily pause.');
  return { days: input.days, categories: [...new Set(input.categories)], markRead: input.markRead, archive: input.archive, protectedSenders: [...new Set(input.protectedSenders.map(s => s.toLowerCase()))], daily: input.daily, dailyPausedUntil, hour: input.hour, timezone: input.timezone, aiEnabled: input.aiEnabled };
}
export function dailyIsPaused(rules, now = Date.now()) { return rules.dailyPausedUntil === -1 || (rules.dailyPausedUntil || 0) > now; }
export function gmailQuery(rules) {
  return `in:inbox ${!rules.archive && rules.markRead ? 'is:unread ' : ''}older_than:${rules.days}d {${rules.categories.map(c => `category:${c}`).join(' ')}} -is:starred -is:important`;
}
export function headersOf(message) {
  return Object.fromEntries((message.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value]));
}
export function senderAddress(from = '') { return (from.match(/<([^>]+)>/)?.[1] || from).trim().toLowerCase(); }
export function protectedReason(message, rules, now = Date.now()) {
  const labels = message.labelIds || [];
  if (!labels.includes('INBOX')) return 'No longer in inbox';
  if (labels.includes('STARRED') || labels.includes('IMPORTANT')) return 'Starred or important';
  if (!Number.isFinite(Number(message.internalDate)) || Number(message.internalDate) > now - rules.days * 86400000) return 'Recent message';
  if (!rules.categories.some(c => labels.includes(`CATEGORY_${c.toUpperCase()}`))) return 'Outside selected categories';
  const headers = headersOf(message);
  if (rules.protectedSenders.includes(senderAddress(headers.from))) return 'Protected sender';
  if (/\b(receipt|invoice|payment|statement|bank|security|password|verification|verify|authentication|login|sign.in|booking|reservation|itinerary|ticket|legal|tax|medical|appointment|insurance|delivery|order|refund|account|fraud|otp|one.time)\b/i.test(`${headers.subject || ''} ${headers.from || ''}`)) return 'Potentially important — kept for review';
  return null;
}
export function changesFor(message, rules, cleanedLabel) {
  const labels = message.labelIds || [];
  return { addLabelIds: labels.includes(cleanedLabel) ? [] : [cleanedLabel], removeLabelIds: [rules.archive && 'INBOX', rules.markRead && 'UNREAD'].filter(x => x && labels.includes(x)) };
}
export function undoChanges(change) { return { addLabelIds: change.removeLabelIds, removeLabelIds: change.addLabelIds }; }
export function dailyKey(rules, now = new Date()) {
  if (dailyIsPaused(rules, now.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: rules.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]));
  return Number(parts.hour) >= rules.hour ? `${parts.year}-${parts.month}-${parts.day}` : null;
}
