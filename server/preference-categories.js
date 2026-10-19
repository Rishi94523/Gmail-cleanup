export const PREFERENCE_CATEGORIES = Object.freeze({
  product_announcements: { label: 'Product announcements', question: 'Do you want product announcements in your inbox?' },
  sales_discounts: { label: 'Sales and discounts', question: 'Do you want sales and discount emails in your inbox?' },
  job_opportunities: { label: 'Job opportunities', question: 'Do you want job opportunities and recruiting emails in your inbox?' },
  newsletters: { label: 'Newsletters and blogs', question: 'Do you want newsletters and blog updates in your inbox?' },
  social_notifications: { label: 'Social notifications', question: 'Do you want social activity notifications in your inbox?' },
  event_invitations: { label: 'Events and webinars', question: 'Do you want event and webinar invitations in your inbox?' },
  surveys_feedback: { label: 'Surveys and feedback', question: 'Do you want survey and feedback requests in your inbox?' },
  cold_outreach: { label: 'Cold outreach', question: 'Do you want unsolicited business outreach in your inbox?' }
});
export function categoryScope(category) {
  if (Object.hasOwn(PREFERENCE_CATEGORIES, category || '')) return { kind: 'category', category, label: PREFERENCE_CATEGORIES[category].label, scopeHash: `category:${category}` };
  if (!/^topic_[a-z][a-z0-9_]{2,48}$/.test(category || '')) return null;
  const label = category.slice(6).replaceAll('_', ' ');
  return { kind: 'category', category, label: label[0].toUpperCase() + label.slice(1), scopeHash: `category:${category}` };
}
export function discoveryModelKey(model) { return `${model || 'default'}:body-topic-preferences-v2`; }
export function validateExceptions(input) {
  if (!Array.isArray(input) || input.length > 50) throw new Error('Use up to 50 sender exceptions.');
  return input.map(rule => {
    if (!rule || typeof rule.id !== 'string' || rule.id.length > 80 || !rule.id || !['sender','domain'].includes(rule.type) || typeof rule.value !== 'string' || !['keep','read','archive','both'].includes(rule.action) || (rule.category !== 'all' && !categoryScope(rule.category))) throw new Error('Choose a valid sender exception.');
    const value = rule.value.trim().toLowerCase();
    if (value.length > 254 || (rule.type === 'sender' ? !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(value) : !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(value))) throw new Error('Use a complete sender address or domain, such as apple.com.');
    return { id: rule.id, type: rule.type, value, category: rule.category, action: rule.action };
  });
}
export function matchingException(rules, sender, category) {
  const domain = sender.split('@')[1] || '';
  const matches = (rules || []).filter(r => (r.category === 'all' || r.category === category) && (r.type === 'sender' ? r.value === sender : domain === r.value || domain.endsWith(`.${r.value}`)));
  const priority = r => (r.type === 'sender' ? 4 : 0) + (r.category === 'all' ? 0 : 2) + (r.action === 'keep' ? 1 : 0);
  return matches.sort((a, b) => priority(b) - priority(a))[0] || null;
}
