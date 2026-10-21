// Questions need both a model-selected category and matching inbox evidence.
// These conservative checks suppress irrelevant onboarding questions; they never
// authorize a Gmail action or classify an email for cleanup.
const patterns = {
  job_opportunities: /\b(job|jobs|recruit\w*|hiring|career\w*|interview\w*|vacanc\w*|glassdoor|indeed)\b/i,
  newsletters: /\b(newsletter\w*|digest\w*|substack|blog\w*|weekly|edition|publication)\b/i,
  product_announcements: /\b(product\w*|announcement\w*|launch\w*|release\w*|new feature\w*|what.s new)\b/i,
  sales_discounts: /\b(sale\w*|discount\w*|deal\w*|offer\w*|coupon\w*|save \d+|% off)\b/i,
  social_notifications: /\b(liked|mentioned|mention|follow\w*|comment\w*|notification\w*|connection|social)\b/i,
  event_invitations: /\b(event\w*|webinar\w*|invitation\w*|invited|conference\w*|workshop\w*)\b/i,
  surveys_feedback: /\b(survey\w*|feedback|review your|rate your|opinion\w*)\b/i,
  cold_outreach:
    /\b(partnership|business proposal|quick question|introducing myself|grow your|sales pitch|outreach|collaborat\w*)\b/i
};
export function discoveryEvidence(sample) {
  return Object.fromEntries(
    Object.entries(patterns).map(([category, pattern]) => [
      category,
      sample.filter(m => pattern.test(`${m.sender || ''} ${m.subject || ''} ${m.listId || ''}`)).map(m => m.id)
    ])
  );
}
