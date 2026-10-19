// Gmail returns search results newest first. Keep the agent in the Primary tab.
export const PRIMARY_INBOX_QUERY = 'in:inbox category:primary is:unread';
const OTHER_TABS = new Set(['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS']);
export function outsidePrimary(message) {
  return (message.labelIds || []).some(label => OTHER_TABS.has(label));
}
