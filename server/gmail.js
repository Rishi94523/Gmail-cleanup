import { timed } from './telemetry.js';
import { PRIMARY_INBOX_QUERY } from './inbox-scope.js';

export const UNREAD_COUNT_LIMIT = 1000;
export async function primaryUnreadCount(gmail, limit = UNREAD_COUNT_LIMIT) {
  // Gmail's resultSizeEstimate is approximate. Count matching IDs across pages
  // without downloading subjects, bodies, or attachments. Stop at the limit so a
  // very large backlog does not cost one Gmail request per 500 messages.
  const ids = new Set();
  const pages = new Set();
  let pageToken;
  do {
    const page = await gmail(
      `messages?${new URLSearchParams({ q: PRIMARY_INBOX_QUERY, maxResults: '500', fields: 'messages(id),nextPageToken', ...(pageToken ? { pageToken } : {}) })}`
    );
    for (const message of page.messages || []) ids.add(message.id);
    pageToken = page.nextPageToken;
    if (pageToken && pages.has(pageToken)) throw new Error('Primary unread count could not finish. Please try again.');
    if (pageToken) pages.add(pageToken);
  } while (pageToken && ids.size < limit);
  return { count: Math.min(ids.size, limit), capped: Boolean(pageToken) || ids.size > limit };
}
// Google answers 400 invalid_token when the user already removed access or the
// token expired; access is gone either way, so local data can still be removed.
export async function revokeGoogleToken(token, fetcher = fetch) {
  if (!token) return;
  const response = await fetcher('https://oauth2.googleapis.com/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
    signal: AbortSignal.timeout(15000)
  });
  if (response.ok) return;
  const result = await response.json().catch(() => ({}));
  if (response.status === 400 && result.error === 'invalid_token') return;
  throw new Error(
    'Agent paused, but Google revocation failed. Try disconnecting again or remove app access from your Google account.'
  );
}

export function jsonFetch(url, options = {}) {
  const parsed = new URL(url);
  const path = parsed.pathname
    .replace(/\/messages\/[^/]+/g, '/messages/:id')
    .replace(/\/threads\/[^/]+/g, '/threads/:id')
    .replace(/\/labels\/[^/]+/g, '/labels/:id');
  return timed('google.request', () => jsonFetchInternal(url, options), {
    api: parsed.hostname === 'oauth2.googleapis.com' ? 'oauth' : 'gmail',
    path,
    method: options.method || 'GET',
    format: parsed.searchParams.get('format') || undefined
  });
}
async function jsonFetchInternal(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20000) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const needsReconnect = response.status === 401 || result.error === 'invalid_grant';
    const knownErrors = new Set([
      'invalid_grant',
      'invalid_client',
      'invalid_request',
      'unauthorized_client',
      'access_denied'
    ]);
    console.warn(
      JSON.stringify({
        event: 'gmail_request_failed',
        status: response.status,
        api: new URL(url).hostname === 'oauth2.googleapis.com' ? 'oauth' : 'gmail',
        reason: knownErrors.has(result.error) ? result.error : 'request_rejected',
        throttled:
          response.status === 429 ||
          (result.error?.errors || []).some(error =>
            ['rateLimitExceeded', 'userRateLimitExceeded'].includes(error.reason)
          )
      })
    );
    const error = new Error(
      needsReconnect
        ? 'Gmail connection expired. Please reconnect.'
        : `Provider request failed (${response.status}). Try again later.`
    );
    error.status = response.status;
    if (needsReconnect) {
      error.publicCode = 'GMAIL_AUTH';
      error.publicMessage = 'Your Gmail connection expired. Reconnect Gmail before continuing.';
    }
    throw error;
  }
  return result;
}
export function gmailClient(account, config, saveTokens) {
  let tokens = account.tokens;
  async function accessToken() {
    if (tokens.access_token && tokens.expires_at > Date.now() + 60000) return tokens.access_token;
    const refreshed = await jsonFetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: tokens.refresh_token,
        grant_type: 'refresh_token'
      })
    });
    tokens = { ...tokens, ...refreshed, expires_at: Date.now() + refreshed.expires_in * 1000 };
    await saveTokens(tokens);
    return tokens.access_token;
  }
  return async (path, body, method) => {
    const token = await accessToken();
    return jsonFetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
  };
}
export async function metadata(gmail, id) {
  const parameters = new URLSearchParams({ format: 'metadata' });
  for (const name of [
    'From',
    'Subject',
    'List-Unsubscribe',
    'List-Unsubscribe-Post',
    'Authentication-Results',
    'DKIM-Signature'
  ])
    parameters.append('metadataHeaders', name);
  return gmail(`messages/${encodeURIComponent(id)}?${parameters}`);
}
export async function mapLimit(items, limit, fn) {
  const output = new Array(items.length);
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (index < items.length) {
        const current = index++;
        output[current] = await fn(items[current], current);
      }
    })
  );
  return output;
}
