// Only apply to system errors and activity details, never to user email content.
export function customerMessage(message, fallback = 'Something went wrong. Please try again.') {
  const text = String(message || '');
  if (/response limit|AI_TRUNCATED/i.test(text)) return 'Your agent could not finish this step. Please try again later.';
  if (/Nebius|Token Factory|OpenRouter|Nemotron|API[_ -]?KEY|AI_PROVIDER|AI_MODEL|OAuth client|redirect URI|README|\.env\b|server configuration|invalid JSON|incomplete.*JSON|model access|provider.*changed/i.test(text)) return 'This feature is temporarily unavailable. Please try again later.';
  return text || fallback;
}
