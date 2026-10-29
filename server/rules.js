// Account-level rules: protected senders and the daily schedule. What to do
// with each email is decided by the agent's preferences (rules.agent).
export const DEFAULT_RULES = Object.freeze({
  protectedSenders: [],
  daily: false,
  dailyPausedUntil: 0,
  hour: 9,
  runsPerDay: 1,
  timezone: 'Asia/Kolkata'
});
export function validateRules(input) {
  if (!input) throw new Error('Choose your settings.');
  const protectedSenders = input.protectedSenders ?? [];
  if (
    !Array.isArray(protectedSenders) ||
    protectedSenders.length > 100 ||
    protectedSenders.some(
      s => typeof s !== 'string' || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(s)
    )
  )
    throw new Error('Protected senders must be complete email addresses (up to 100).');
  if (typeof input.daily !== 'boolean') throw new Error('Choose whether to run daily cleanup.');
  if (!Number.isInteger(input.hour) || input.hour < 0 || input.hour > 23) throw new Error('Choose a valid daily hour.');
  const runsPerDay = input.runsPerDay ?? 1;
  if (![1, 2, 3].includes(runsPerDay)) throw new Error('Choose 1, 2 or 3 cleanups per day.');
  if (typeof input.timezone !== 'string' || input.timezone.length > 100) throw new Error('Choose a valid timezone.');
  try {
    new Intl.DateTimeFormat('en', { timeZone: input.timezone }).format();
  } catch {
    throw new Error('Choose a valid timezone.');
  }
  const dailyPausedUntil = input.dailyPausedUntil ?? 0;
  if (!Number.isSafeInteger(dailyPausedUntil) || dailyPausedUntil < -1 || dailyPausedUntil > 8640000000000000)
    throw new Error('Choose a valid daily pause.');
  return {
    protectedSenders: [...new Set(protectedSenders.map(s => s.toLowerCase()))],
    daily: input.daily,
    dailyPausedUntil,
    hour: input.hour,
    runsPerDay,
    timezone: input.timezone
  };
}
export function dailyIsPaused(rules, now = Date.now()) {
  return rules.dailyPausedUntil === -1 || (rules.dailyPausedUntil || 0) > now;
}
export function headersOf(message) {
  return Object.fromEntries((message.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value]));
}
export function senderAddress(from = '') {
  return (from.match(/<([^>]+)>/)?.[1] || from).trim().toLowerCase();
}
export function undoChanges(change) {
  return { addLabelIds: change.removeLabelIds, removeLabelIds: change.addLabelIds };
}
function localParts(timezone, at) {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    })
      .formatToParts(at)
      .map(p => [p.type, p.value])
  );
}
// Local start hours of each daily run, evenly spaced across 24 hours.
export function dailyHours(rules) {
  const runs = rules.runsPerDay || 1;
  return Array.from({ length: runs }, (_, i) => (rules.hour + (i * 24) / runs) % 24);
}
// Key of the most recent scheduled run that is due, or null. Keys sort in time
// order ("2026-10-29" < "2026-10-29#2" < "2026-10-29#3" < "2026-10-30"), so a
// run is due when the account's last claimed key is older than this one.
export function dailyKey(rules, now = new Date()) {
  if (dailyIsPaused(rules, now.getTime())) return null;
  const parts = localParts(rules.timezone, now);
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const runs = rules.runsPerDay || 1;
  if (runs === 1) return minutes >= rules.hour * 60 ? `${parts.year}-${parts.month}-${parts.day}` : null;
  // A cycle starts at the chosen hour and may cross midnight (e.g. 21:00, 05:00, 13:00).
  const sinceStart = (minutes - rules.hour * 60 + 1440) % 1440;
  const slot = Math.floor(sinceStart / (1440 / runs));
  const start = localParts(rules.timezone, new Date(now.getTime() - sinceStart * 60000));
  const day = `${start.year}-${start.month}-${start.day}`;
  return slot === 0 ? day : `${day}#${slot + 1}`;
}
