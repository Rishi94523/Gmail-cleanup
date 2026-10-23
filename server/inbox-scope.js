// Gmail returns search results newest first. Keep the agent in the Primary tab.
export const PRIMARY_INBOX_QUERY = 'in:inbox category:primary is:unread';
export const PRIMARY_SCOPE_VERSION = 'primary-search-confirmed-v2';
const OTHER_TABS = new Set(['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS']);
export function outsidePrimary(message, { primaryVerified = false } = {}) {
  return !primaryVerified && (message.labelIds || []).some(label => OTHER_TABS.has(label));
}

export async function confirmPrimaryInbox(gmail, message) {
  if (!message.labelIds?.includes('INBOX') || !message.labelIds.includes('UNREAD')) return false;
  if (!outsidePrimary(message)) return true;
  // Category labels can disagree with Gmail's Primary search. Confirm the exact
  // message instead of treating CATEGORY_UPDATES as proof of a different tab.
  const header = message.payload?.headers?.find(h => h.name.toLowerCase() === 'message-id')?.value?.trim();
  const messageId = header?.replace(/^<|>$/g, '');
  if (!messageId || !messageId.includes('@') || !/^[^\s<>"\\:(){}]{1,998}$/.test(messageId)) return false;
  const tokens = new Set();
  let pageToken;
  do {
    const page = await gmail(
      `messages?${new URLSearchParams({ q: `${PRIMARY_INBOX_QUERY} rfc822msgid:${messageId}`, maxResults: '500', fields: 'messages(id),nextPageToken', ...(pageToken ? { pageToken } : {}) })}`
    );
    if (page.messages?.some(m => m.id === message.id)) return true;
    pageToken = page.nextPageToken;
    if (pageToken && tokens.has(pageToken))
      throw new Error('Could not verify Primary inbox membership. Emails were left unchanged.');
    if (pageToken) tokens.add(pageToken);
  } while (pageToken);
  return false;
}
