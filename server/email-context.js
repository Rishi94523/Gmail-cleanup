export function emailTiming(message, now = Date.now()) {
  const received = Number(message.internalDate);
  const valid = Number.isFinite(received) && received > 0;
  const header = message.payload?.headers?.find(header => header.name.toLowerCase() === 'date')?.value;
  const sent = header ? Date.parse(header) : NaN;
  return { sentAt: Number.isFinite(sent) ? new Date(sent).toISOString() : valid ? new Date(received).toISOString() : null, receivedAt: valid ? new Date(received).toISOString() : null, ageDays: valid ? Math.floor((now - received) / 86400000) : null };
}
export function clockContext(timezone = 'UTC', now = Date.now()) {
  return { now: new Date(now).toISOString(), currentDate: new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now), timezone };
}
export function sensitiveNoticeKind(message) {
  const headers = Object.fromEntries((message.payload?.headers || []).map(header => [header.name.toLowerCase(), header.value]));
  const text = `${headers.subject || ''} ${headers.from || ''}`;
  if (/\b(security|password|verification|authentication|login|sign.in|otp|one.time)\b/i.test(text)) return 'security_notices';
  if (/\b(bank|transaction|debited|credited|payment|statement|receipt|refund)\b/i.test(text)) return 'bank_transactions';
  return null;
}
