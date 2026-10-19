import { customerMessage } from '/customer-message.js';
import { createOnboarding } from '/onboarding.js';
import { writePreference } from '/preference-answer.js';
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const number = value => Number(value || 0).toLocaleString();
const date = value => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
let state = null;
let plan = null;
let selected = new Set();
let busy = false;
let page = 'overview';
let toastTimer;
let approval = null;
let learningState = { questions: [], memories: [], discovery: null };
let discoveryStarted = false;

function toast(message) { $('#toast').textContent = customerMessage(message); $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5500); }
function error(message) { $('#error-banner').textContent = customerMessage(message); $('#error-banner').hidden = false; $('#error-banner').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
function showPage(name) {
  page = ['overview', 'subscriptions', 'rules', 'activity', 'questions'].includes(name) ? name : 'overview';
  $$('.page').forEach(el => { el.hidden = el.id !== `page-${page}`; });
  $$('.nav-item').forEach(el => { el.classList.toggle('active', el.dataset.page === page); if (el.dataset.page === page) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); });
  $('#page-name').textContent = { overview: 'Overview', subscriptions: 'Subscriptions', rules: 'Preferences', activity: 'Activity', questions: 'Questions' }[page];
  history.replaceState(null, '', `${location.pathname}#${page}`);
  window.scrollTo({ top: 0, behavior: 'instant' });
}
async function request(path, data) {
  const response = await fetch(path, data === undefined ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state?.csrf || '' }, body: JSON.stringify(data) });
  const result = await response.json(); if (!response.ok) throw new Error(customerMessage(result.error)); return result;
}
function setBusy(value, button, label) {
  busy = value;
  for (const selector of ['#scan-button', '#discover-button', '#save-rules', '#review-cleanup', '#routine-button', '#disconnect-button', '#confirm-disconnect']) { const el = $(selector); if (el) el.disabled = value || !state?.connected; }
  $$('#preview-body input').forEach(el => { el.disabled = value || el.dataset.eligible !== 'true'; });
  if (button) { if (value) { button.dataset.originalText = button.textContent; button.textContent = label; button.disabled = true; } else { button.textContent = button.dataset.originalText; button.disabled = !state?.connected; } }
  document.body.setAttribute('aria-busy', String(value));
  if (state) renderAgentControls();
  if (!value && state) queueMicrotask(() => maybeDiscover());
}
async function operation(button, label, fn) {
  if (busy) return;
  $('#error-banner').hidden = true; setBusy(true, button, label);
  try { await fn(); } catch (err) { if (button?.id === 'agent-start') { $('#agent-stage').textContent = 'Agent stopped. Check Activity before continuing.'; $('#agent-progress .agent-motion').hidden = true; } error(err.message); try { await refresh(false); } catch {} }
  finally { setBusy(false, button); }
}
function connect() {
  if (!state?.configured) { toast('Gmail connection is temporarily unavailable. Please try again later.'); $('#setup-banner').scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
  window.location.assign('/auth/google');
}
function empty(title, text) { return `<div class="empty-state"><strong>${escape(title)}</strong><p>${escape(text)}</p></div>`; }
function renderRules() {
  const rules = state.rules;
  $('#rule-days').value = rules.days;
  $$('input[name=category]').forEach(el => { el.checked = rules.categories.includes(el.value); });
  $('#rule-archive').checked = rules.archive; $('#rule-read').checked = rules.markRead;
  $('#rule-protected').value = rules.protectedSenders.join('\n'); $('#rule-daily').checked = rules.daily;
  $('#rule-hour').value = rules.hour;
  if (!$$('#rule-zone option').some(option => option.value === rules.timezone)) $('#rule-zone').add(new Option(rules.timezone, rules.timezone));
  $('#rule-zone').value = rules.timezone; $('#rule-ai').checked = rules.aiEnabled && rules.aiConsentProvider === (state.aiProvider || 'openrouter');
  $('#rule-ai').disabled = !state.aiConfigured;
  $('#ai-status').textContent = state.aiConfigured ? 'Enable only if you agree to AI processing.' : 'AI assistance is temporarily unavailable. You can still save your preferences.';
  $('#connection-settings-copy').textContent = state.connected ? `Connected as ${state.email}` : 'Connect Gmail to save your preferences.';
  $('#disconnect-button').hidden = !state.connected;
}
function renderActivity() {
  const renderRun = run => {
    const titles = { cleanup: 'Inbox cleanup', daily: 'Daily tidy', unsubscribe: 'Unsubscribe request' };
    const summaries = { running: 'In progress. Refresh to check completion.', completed: `${number(run.changed)} emails tidied · ${number(run.skipped)} kept after rechecking`, needs_review: 'Partially completed or interrupted. Review before continuing.', undone: 'Cleanup restored', requested: 'Request accepted by the sender' };
    return `<div class="list-row"><span class="row-icon" aria-hidden="true">${run.kind === 'unsubscribe' ? '↗' : run.status === 'undone' ? '↶' : '✓'}</span><div class="row-main"><strong>${escape(titles[run.kind] || run.kind)}</strong><p>${escape(summaries[run.status] || run.status)}</p>${run.detail ? `<small>${escape(customerMessage(run.detail))}</small>` : ''}</div><div class="row-side"><time datetime="${new Date(run.created).toISOString()}">${date(run.created)}</time>${run.undoable ? `<button class="text-button" data-undo="${escape(run.id)}">Undo cleanup ↶</button>` : `<span class="soft-tag">${escape(run.status.replaceAll('_', ' '))}</span>`}</div></div>`;
  };
  $('#recent-activity').innerHTML = state.runs.length ? state.runs.slice(0, 3).map(renderRun).join('') : empty('Your fresh start is waiting.', 'Once you run a cleanup, you’ll see what changed here. Every action has a paper trail.');
  $('#activity-list').innerHTML = state.runs.length ? state.runs.map(renderRun).join('') : empty('Nothing moved. Nothing missed.', 'Your cleanups, daily routines, and unsubscribe requests will appear here.');
  $('#daily-error').hidden = !state.lastError; $('#daily-error').textContent = state.lastError ? `Daily agent needs attention: ${state.lastError}` : '';
}
function renderSubscriptions() {
  $('#subscription-count').textContent = state.subscriptions.filter(s => ['review', 'manual'].includes(s.status)).length;
  const statuses = { review: 'One-click available · approval required', manual: 'Manual review in Gmail', requested: 'Request submitted · allow time for the sender', uncertain: 'Completion unknown · check before retrying' };
  $('#subscriptions-list').innerHTML = state.subscriptions.length ? state.subscriptions.map(sub => `<div class="list-row"><span class="row-icon" aria-hidden="true">${escape(sub.sender[0]?.toUpperCase() || '@')}</span><div class="row-main"><strong>${escape(sub.sender)}</strong><p>${escape(statuses[sub.status] || sub.status)}</p>${sub.host ? `<small>Request destination: ${escape(sub.host)}</small>` : ''}</div><div class="row-side">${sub.status === 'review' ? `<button class="secondary" data-unsubscribe="${escape(sub.sender)}">Review unsubscribe ↗</button>` : `<a class="text-button" href="https://mail.google.com/mail/u/0/#search/${encodeURIComponent(`from:(${sub.sender})`)}" target="_blank" rel="noopener noreferrer">Review in Gmail ↗</a>`}</div></div>`).join('') : empty('Make space for the good mail.', 'Find subscriptions to inspect the latest 100 inbox messages. Repeat later to discover more senders.');
}
function renderPreview() {
  $('#preview-section').hidden = !plan;
  $('#cleanup-approval').hidden = true; approval = null;
  if (!plan) return;
  const candidates = plan.decisions.filter(d => !d.reason);
  $('#preview-count').textContent = `${number(candidates.length)} ready to tidy`;
  let nextButton = $('#next-batch');
  if (!nextButton) { nextButton = document.createElement('button'); nextButton.id = 'next-batch'; nextButton.className = 'secondary'; nextButton.textContent = 'Review next batch →'; nextButton.type = 'button'; $('.preview-footer').prepend(nextButton); }
  nextButton.hidden = !plan.moreAvailable; nextButton.disabled = busy;
  $('#preview-description').textContent = `${number(plan.decisions.length)} messages inspected in this batch. ${plan.moreAvailable ? 'More matching mail remains; scan again after cleanup for the next batch.' : 'All messages returned for this batch are shown.'} Potentially important mail is kept. Preview expires after one hour.`;
  $('#preview-body').innerHTML = plan.decisions.length ? plan.decisions.map(item => `<tr class="${item.reason ? 'kept' : ''}"><td><input type="checkbox" data-message="${escape(item.id)}" data-eligible="${!item.reason}" aria-label="Select ${escape(item.subject)}" ${item.reason ? 'disabled' : selected.has(item.id) ? 'checked' : ''}></td><td><span class="subject">${escape(item.subject)}</span><span class="sender">${escape(item.sender)}</span></td><td>${date(item.date)}</td><td><span class="decision">${escape(item.reason || item.aiReason || 'Matches your cleanup rules')}</span><small class="sender">${escape(item.source)}</small></td></tr>`).join('') : '<tr><td colspan="4">No matching emails in this batch. Try a different age or category in your rules.</td></tr>';
  updateSelection();
}
function updateSelection() {
  const eligible = plan?.decisions.filter(d => !d.reason).length || 0;
  $('#selection-summary').textContent = `${number(selected.size)} of ${number(eligible)} eligible emails selected`;
  $('#select-all').checked = eligible > 0 && selected.size === eligible; $('#select-all').indeterminate = selected.size > 0 && selected.size < eligible; $('#select-all').disabled = !eligible || busy;
  $('#review-cleanup').disabled = !selected.size || busy;
  $('#cleanup-approval').hidden = true; approval = null;
}
function render() {
  const connected = state.connected; const rules = state.rules;
  $('#account-label').textContent = connected ? state.email : 'Your Gmail'; $('#account-state').textContent = connected ? 'Connected securely' : 'Not connected'; $('#avatar').textContent = connected ? state.email[0].toUpperCase() : 'G';
  $('#connection-dot').classList.toggle('on', connected); $('#account-button').textContent = connected ? 'Preferences ↗' : 'Connect Gmail ↗';
  $('#agent-pill').classList.toggle('on', connected && rules.daily && state.schedulerActive); $('#agent-pill').innerHTML = `<i></i> ${connected && rules.daily && state.schedulerActive ? 'Daily agent on' : 'Agent paused'}`;
  $('#metric-cleaned').textContent = connected ? number(state.totals?.cleaned) : '—';
  $('#metric-unsubscribed').textContent = connected ? number(state.totals?.requested) : '—';
  $('#metric-routine').textContent = rules.daily && connected ? 'Every day' : 'Not set';
  const hour = `${String(rules.hour).padStart(2, '0')}:00`;
  $('#routine-caption').textContent = connected && rules.daily ? `${hour} · ${rules.timezone}` : 'A quieter inbox on autopilot';
  $('#routine-time').textContent = hour; $('#routine-zone').textContent = rules.timezone; $('#routine-state').textContent = connected && rules.daily ? 'Enabled' : 'Paused';
  $('#routine-button').textContent = connected && rules.daily ? 'Manage my daily routine ↗' : 'Set up my daily routine ↗';
  $('#rules-summary').textContent = `${rules.categories.map(c => c[0].toUpperCase() + c.slice(1)).join(' & ')} · older than ${rules.days} days`;
  $('#actions-summary').textContent = `${rules.archive ? 'Archive to “Cleaned by agent”' : 'Keep in inbox with “Cleaned by agent” label'} · ${rules.markRead ? 'mark as read' : 'keep unread status'}`;
  $('#setup-banner').hidden = connected;
  $('#setup-banner').innerHTML = state.configured ? '<div><strong>A calmer inbox starts here.</strong><p>Connect your Gmail, choose your boundaries, and preview your first cleanup. Nothing moves until you approve.</p></div><button class="primary" id="connect-panel">Connect Gmail ↗</button>' : `<div><strong>Gmail connection is temporarily unavailable.</strong><p>Please try again later. You can explore your preferences in the meantime.</p></div><button class="secondary" id="setup-rules">Explore the rules ↗</button>`;
  renderRules(); renderActivity(); renderSubscriptions(); renderPreview();
  renderAgentPreferences();
  for (const selector of ['#scan-button', '#discover-button', '#save-rules', '#routine-button']) $(selector).disabled = busy || !connected;
  if (!connected) { $('#metric-unread').textContent = '—'; $('#unread-caption').textContent = 'Connect to see your inbox'; }
}
async function refresh(mailbox = false) {
  state = await request('/api/status');
  const samePlan = plan?.id === state.plan?.id;
  plan = state.plan;
  if (!samePlan) selected = new Set(plan?.decisions.filter(d => !d.reason).map(d => d.id) || []);
  render();
  if (mailbox && state.connected) {
    try { const profile = await request('/api/mailbox'); $('#metric-unread').textContent = number(profile.unread); $('#unread-caption').textContent = `Across ${number(profile.messages)} emails in Gmail`; }
    catch (err) { $('#unread-caption').textContent = 'Mailbox count unavailable'; error(err.message); }
  }
  if (state.connected) await loadLearning();
  else { learningState = { questions: [], memories: [], discovery: null }; renderLearning(); }
  queueMicrotask(() => maybeDiscover());
}
function rulesInput() {
  return { days: Number($('#rule-days').value), categories: $$('input[name=category]:checked').map(input => input.value), archive: $('#rule-archive').checked, markRead: $('#rule-read').checked, protectedSenders: $('#rule-protected').value.split(/[\n,]+/).map(s => s.trim()).filter(Boolean), daily: $('#rule-daily').checked, hour: Number($('#rule-hour').value), timezone: $('#rule-zone').value, aiEnabled: $('#rule-ai').checked, aiConsentProvider: $('#rule-ai').checked ? (state.aiProvider || 'openrouter') : '' };
}
for (let i = 0; i < 24; i++) $('#rule-hour').add(new Option(`${String(i).padStart(2, '0')}:00`, i));
$$('[data-page]').forEach(button => button.addEventListener('click', () => showPage(button.dataset.page)));
$$('[data-goto]').forEach(button => button.addEventListener('click', () => showPage(button.dataset.goto)));
$('#account-button').addEventListener('click', () => state?.connected ? showPage('rules') : connect());
$('#routine-button').addEventListener('click', () => { showPage('rules'); $('#rule-daily').focus(); });
$('#rules-form').addEventListener('submit', event => { event.preventDefault(); operation($('#save-rules'), 'Saving…', async () => { await request('/api/rules', rulesInput()); await refresh(); toast('Your rules are saved. Scan again for a fresh preview.'); }); });
$('#scan-button').addEventListener('click', () => operation($('#scan-button'), 'Reviewing up to 100 emails…', async () => { const result = await request('/api/scan', {}); await refresh(); plan = result.plan; selected = new Set(plan.decisions.filter(d => !d.reason).map(d => d.id)); renderPreview(); $('#preview-section').scrollIntoView({ behavior: 'smooth', block: 'start' }); }));
$('#discover-button').addEventListener('click', () => operation($('#discover-button'), 'Finding mailing lists…', async () => { const result = await request('/api/discover', {}); await refresh(); toast(`Inspected ${number(result.inspected)} recent messages for subscriptions.`); }));
$('#select-all').addEventListener('change', event => { selected = event.target.checked ? new Set(plan.decisions.filter(d => !d.reason).map(d => d.id)) : new Set(); $$('#preview-body input[data-eligible=true]').forEach(input => { input.checked = selected.has(input.dataset.message); }); updateSelection(); });
$('#preview-body').addEventListener('change', event => { const id = event.target.dataset.message; if (!id) return; if (event.target.checked) selected.add(id); else selected.delete(id); updateSelection(); });
$('#review-cleanup').addEventListener('click', () => {
  if (!plan || !selected.size || busy) return;
  approval = { planId: plan.id, ids: [...selected] };
  $('#cleanup-approval').innerHTML = `<h3>Ready to tidy ${number(selected.size)} emails?</h3><p>${plan.rules.archive ? 'These messages will leave your inbox and receive the “Cleaned by agent” label.' : 'These messages stay in the inbox and receive the “Cleaned by agent” label.'} ${plan.rules.markRead ? 'Matching unread messages will also be marked as read.' : 'Their unread status will stay the same.'} Protections are checked again before each change. You can undo this cleanup from Activity.</p><div class="approval-actions"><button class="primary" id="confirm-cleanup">Approve cleanup →</button><button class="text-button" id="cancel-cleanup">Keep reviewing</button></div>`;
  $('#cleanup-approval').hidden = false; $('#confirm-cleanup').focus();
});
$('#cleanup-approval').addEventListener('click', event => {
  if (event.target.id === 'cancel-cleanup') { $('#cleanup-approval').hidden = true; approval = null; }
  if (event.target.id === 'confirm-cleanup' && approval) {
    const approved = { ...approval };
    operation(event.target, 'Tidying your inbox…', async () => { const result = await request('/api/apply', approved); await refresh(true); toast(`${number(result.changed)} emails tidied. Undo is available in Activity.`); });
  }
});
document.addEventListener('click', event => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.id === 'connect-panel') connect();
  if (button.id === 'setup-rules') showPage('rules');
  if (button.id === 'next-batch' && plan) operation(button, 'Reviewing next batch…', async () => { await request('/api/scan', { nextPlanId: plan.id }); await refresh(); toast('Next batch loaded. The previous batch was left unchanged.'); });
  if (button.dataset.unsubscribe) {
    const sub = state.subscriptions.find(s => s.sender === button.dataset.unsubscribe); if (!sub || busy) return;
    $('#unsubscribe-approval').innerHTML = `<h3>Leave this mailing list?</h3><p>Send a one-click unsubscribe request for <strong>${escape(sub.sender)}</strong> to <strong>${escape(sub.host)}</strong>. This contacts the sender and cannot be undone by restoring email. Delivery may take time to stop.</p><div class="approval-actions"><button class="primary" data-confirm-unsubscribe="${escape(sub.sender)}">Send unsubscribe request ↗</button><button class="text-button" id="cancel-unsubscribe">Keep subscription</button></div>`;
    $('#unsubscribe-approval').hidden = false; $('#unsubscribe-approval').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  if (button.id === 'cancel-unsubscribe') $('#unsubscribe-approval').hidden = true;
  if (button.dataset.confirmUnsubscribe) operation(button, 'Submitting request…', async () => { await request('/api/unsubscribe', { sender: button.dataset.confirmUnsubscribe }); $('#unsubscribe-approval').hidden = true; await refresh(); toast('The sender accepted your unsubscribe request. Allow time for mail to stop.'); });
  if (button.dataset.undo) {
    if (busy) return;
    showPage('activity');
    $('#undo-approval').innerHTML = `<h3>Restore this cleanup?</h3><p>Restore the labels and unread status changed by this run. This also affects those same labels if you changed them manually afterward. Other labels stay as they are.</p><div class="approval-actions"><button class="primary" data-confirm-undo="${escape(button.dataset.undo)}">Restore emails ↶</button><button class="text-button" id="cancel-undo">Cancel</button></div>`;
    $('#undo-approval').hidden = false; $('#undo-approval').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  if (button.id === 'cancel-undo') $('#undo-approval').hidden = true;
  if (button.dataset.confirmUndo) operation(button, 'Restoring…', async () => { const result = await request('/api/undo', { runId: button.dataset.confirmUndo }); $('#undo-approval').hidden = true; await refresh(true); toast(`${number(result.restored)} emails restored.`); });
});
$('#disconnect-button').addEventListener('click', () => { $('#disconnect-approval').hidden = false; });
$('#cancel-disconnect').addEventListener('click', () => { $('#disconnect-approval').hidden = true; });
$('#confirm-disconnect').addEventListener('click', event => operation(event.target, 'Disconnecting…', async () => { await request('/api/disconnect', {}); $('#disconnect-approval').hidden = true; await refresh(); showPage('overview'); toast('Gmail disconnected. Local account data removed.'); }));
const onboarding = createOnboarding({ getState: () => state, request, refresh, startAgent, showPage });
const auth = new URLSearchParams(location.search).get('auth');
if (auth) {
  const messages = { connected: 'Gmail connected. Let’s get to know your inbox.', setup: 'Gmail connection is temporarily unavailable. Please try again later.', cancelled: 'Connection cancelled. Your Gmail was not changed.', state: 'The connection link expired. Start again from Connect Gmail.', failed: 'We couldn’t connect your Gmail. Please try connecting again.' };
  $('#notice-banner').textContent = messages[auth] || 'Review your connection settings.'; $('#notice-banner').hidden = false;
}
showPage(location.hash.slice(1));
refresh(true).then(async () => { if (state.connected && (state.access?.recoveryAvailable || ((state.access?.remaining ?? 1) > 0 && (state.access?.recovering || !state.rules.agent?.enabled || (auth === 'connected' && !state.access?.used) || (state.runs[0]?.status === 'needs_review' && !state.runs[0]?.changed))))) { $('#notice-banner').hidden = true; await onboarding.open(); } }).catch(err => error(`The app could not load: ${err.message}`)).finally(() => document.body.classList.remove('booting'));

const agentDefaults = { enabled: false, consent: false, consentProvider: '', keepJobs: true, coldMail: 'exceptional', keepPeople: true, keepNewsletters: true, autoUnsubscribe: false, action: 'read', exceptions: '', interests: '' };
for (let hour = 0; hour < 24; hour++) $('#pref-hour').add(new Option(`${String(hour).padStart(2, '0')}:00`, hour));
function renderAgentControls() {
  const p = { ...agentDefaults, ...state.rules.agent };
  const consentMatches = p.consentProvider === (state.aiProvider || 'openrouter');
  $('#agent-start').disabled = (state.access?.tier === 'free' && !state.access.remaining) || busy || !state.connected || !state.aiConfigured || !p.enabled || !consentMatches;
  $('#agent-learn').disabled = busy || !state.connected || !state.aiConfigured || !$('#agent-consent').checked;
  $('#save-preferences').disabled = busy || !state.connected;
  $('#exception-save').disabled = busy || !state.connected;
  $('#agent-configure').textContent = p.enabled ? 'Edit preferences →' : 'Set my preferences →';
  $('#agent-heading').textContent = p.enabled && consentMatches ? 'Your agent is ready.' : 'Let’s get to know your inbox.';
  $('#agent-status').textContent = !state.aiConfigured ? 'AI setup needed' : p.enabled && consentMatches ? 'Ready' : 'Preferences needed';
  $('#agent-provider-note').textContent = state.aiConfigured ? 'Your agent follows your saved preferences. You can change them anytime.' : 'AI assistance is temporarily unavailable. You can still save your preferences.';
  $('#agent-consent-description').textContent = 'Allows our AI service to analyze sender details, subjects and email text to make cleanup decisions. Attachments are excluded.';
  const free = state.access?.tier === 'free';
  $('#agent-start').textContent = free ? (state.access.remaining ? `Clean up to ${state.access.remaining} emails →` : 'Free cleanup used') : 'Start my agent →';
  $('.agent-budget').textContent = free ? `Free cleanup: ${state.access.used} of 100 Primary emails processed. Daily and additional cleanups are for paid plans. Paid plans are not on sale yet.` : 'Each run processes up to 500 unread messages in Primary. Nothing is deleted.';
  $('#save-preferences').textContent = free && state.access.remaining ? 'Save & start free cleanup →' : 'Save preferences →';
  $('#rule-daily').disabled = free || !state.schedulerActive;
  $('#pref-action').closest('.preference-card').hidden = Boolean(p.topicActions);
  $('#pref-daily').disabled = free || !state.schedulerActive;
  $('#agent-schedule-note').textContent = free ? 'Daily cleanup is reserved for paid plans. Your free first cleanup covers up to 100 emails.' : state.schedulerActive ? 'Runs at your chosen time, even when your browser is closed.' : 'Daily cleanup is currently unavailable. You can still start a cleanup yourself.';
}
function renderAgentPreferences() {
  const p = { ...agentDefaults, ...state.rules.agent };
  for (const [key, id] of [['consent','agent-consent'], ['keepJobs','pref-jobs'], ['keepPeople','pref-people'], ['keepNewsletters','pref-newsletters'], ['autoUnsubscribe','pref-auto-unsubscribe']]) $(`#${id}`).checked = p[key];
  if (p.consentProvider !== (state.aiProvider || 'openrouter')) $('#agent-consent').checked = false;
  for (const [key, id] of [['coldMail','pref-cold'], ['action','pref-action'], ['exceptions','pref-exceptions'], ['interests','pref-interests']]) $(`#${id}`).value = p[key];
  $('#pref-daily').checked = state.rules.daily; $('#pref-hour').value = state.rules.hour; $('#pref-zone').value = state.rules.timezone;
  renderExceptions();
  renderAgentControls();
}
$('#agent-consent').addEventListener('change', () => { renderAgentControls(); maybeDiscover(); });
function maybeDiscover() {
  if (document.body.classList.contains('booting') || onboarding.active || !state?.connected || !state.aiConfigured || busy || discoveryStarted || learningState.discovery || !$('#agent-consent').checked) return;
  discoveryStarted = true;
  operation($('#agent-learn'), 'Learning your inbox…', async () => {
  const learned = await request('/api/agent/learn', { consent: $('#agent-consent').checked, provider: state.aiProvider || 'openrouter' });
  renderDiscovery(learned); await loadLearning();
  });
}
$('#agent-learn').addEventListener('click', () => { discoveryStarted = false; learningState.discovery = null; maybeDiscover(); });
$('#preferences-form').addEventListener('submit', event => {
  event.preventDefault();
  const consent = $('#agent-consent').checked;
  const agent = { ...state.rules.agent, consent, consentProvider: consent ? (state.aiProvider || 'openrouter') : '', enabled: consent && state.aiConfigured, keepJobs: $('#pref-jobs').checked, keepPeople: $('#pref-people').checked, keepNewsletters: $('#pref-newsletters').checked, autoUnsubscribe: $('#pref-auto-unsubscribe').checked, coldMail: $('#pref-cold').value, action: $('#pref-action').value, exceptions: $('#pref-exceptions').value, interests: $('#pref-interests').value };
  const rules = { ...state.rules, agent, aiEnabled: state.rules.aiEnabled && state.rules.aiConsentProvider === (state.aiProvider || 'openrouter'), daily: agent.enabled && state.schedulerActive && $('#pref-daily').checked, hour: Number($('#pref-hour').value), timezone: $('#pref-zone').value };
  operation($('#save-preferences'), 'Saving…', async () => { await request('/api/rules', rules); await refresh(); if (agent.enabled && state.access?.tier === 'free' && state.access.remaining) { if (learningState.questions.length) { showPage('questions'); toast('Answer your setup questions, then start your free cleanup from Overview.'); } else { showPage('overview'); await startAgent(); } } else { showPage('overview'); toast(agent.enabled ? 'Preferences saved. Start your agent when you’re ready.' : 'Preferences saved. Your agent is paused.'); } });
});
async function startAgent(onEvent = () => {}) {
  $('#agent-progress').hidden = false; $('#agent-progress .agent-motion').hidden = false; $('#agent-decisions').innerHTML = ''; $('#agent-stage').textContent = 'Connecting to your inbox'; $('#agent-counts').textContent = ''; $('#agent-meter').value = 0;
  const response = await fetch('/api/agent/run', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf }, body: JSON.stringify({ authorize: true }) });
  if (!response.ok) throw new Error('Agent could not start. Reload and try again.');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true }); let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const event = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        if (event.type === 'heartbeat') continue;
        onEvent(event);
        if (event.type === 'question') await loadLearning();
        if (event.type === 'error') throw new Error(customerMessage(event.message));
        if (event.type === 'stage') $('#agent-stage').textContent = event.message;
        if (event.total) $('#agent-meter').max = event.total;
        if (event.inspected !== undefined) $('#agent-meter').value = event.inspected;
        if (event.type === 'decision') {
          const labels = { keep: 'Kept', read: 'Marked read', archive: 'Archived', both: 'Read & archived', unsubscribe: 'Unsubscribe requested' };
          $('#agent-decisions').insertAdjacentHTML('afterbegin', `<div class="list-row"><div class="row-main"><strong>${escape(labels[event.action])} · ${escape(event.subject)}</strong><p>${escape(event.reason)}</p></div></div>`);
          while ($('#agent-decisions').children.length > 8) $('#agent-decisions').lastElementChild.remove();
          $('#agent-counts').textContent = `${number(event.inspected)} read · ${number(event.changed)} changed · ${number(event.kept - (event.waiting || 0))} kept${event.waiting ? ` · ${number(event.waiting)} need review` : ""}`;
        }
        if (event.type === 'complete') { completed = true; $('#agent-stage').textContent = event.moreAvailable ? 'Run finished. More unread mail remains.' : 'Run finished.'; $('#agent-counts').textContent = `${number(event.inspected)} inspected · ${number(event.changed)} changed · ${number(event.kept - (event.waiting || 0))} kept${event.waiting ? ` · ${number(event.waiting)} need review` : ""} · ${number(event.unsubscribed)} unsubscribe requests`; }
      }
    }
    if (!completed) throw new Error('Connection interrupted. Check Activity before starting again.');
  } finally {
    await reader.cancel().catch(() => {}); $('#agent-progress .agent-motion').hidden = true; await refresh(true);
  }
}
$('#agent-start').addEventListener('click', () => operation($('#agent-start'), 'Agent working…', startAgent));
const detailsButton = document.createElement('button'); detailsButton.className = 'secondary'; detailsButton.textContent = 'Show agent decisions';
const decisionHistory = document.createElement('div'); decisionHistory.id = 'agent-history';
$('#page-activity').append(detailsButton, decisionHistory);
detailsButton.addEventListener('click', () => operation(detailsButton, 'Loading decisions…', async () => {
  const result = await request('/api/agent/history', {});
  decisionHistory.innerHTML = result.logs.length ? result.logs.map(log => `<details><summary>Run · ${number(log.decisions.length)} decisions</summary>${log.decisions.map(d => `<div class="agent-log-entry"><strong>${escape(d.subject)}</strong><p>${escape(d.action)} · ${escape(d.reason)}</p></div>`).join('')}</details>`).join('') : '<p>No agent decisions yet.</p>';
}));

let learningSignature = '';
function renderDiscovery(discovery) {
  if (!discovery) return;
  $('#agent-suggestions').innerHTML = `<strong>${escape(discovery.summary)}</strong><ul>${discovery.suggestions.map(s => `<li>${escape(s.note)}</li>`).join('')}</ul><p>Based on ${number(discovery.inspected)} messages. Adjust your preferences below; no emails were changed.</p>`;
}
async function loadLearning() {
  if (!state?.connected) return;
  const result = await request('/api/agent/questions');
  const signature = JSON.stringify(result);
  if (signature === learningSignature) return;
  learningSignature = signature; learningState = result; renderLearning();
}
function renderLearning() {
  const count = learningState.questionsTotal ?? learningState.questions.length;
  $('#question-count').textContent = number(count); $('#question-notice').hidden = count === 0;
  $('#question-notice-title').textContent = `${number(count)} ${count === 1 ? 'question from your agent' : 'questions from your agent'}`;
  $('#questions-tray').innerHTML = count ? learningState.questions.map(q => `<form class="question-card" data-question="${escape(q.id)}"><p class="eyebrow">${escape(q.scope.label || q.scope.listId || q.scope.sender)}</p><h2>${escape(q.question)}</h2><p>${escape(q.reason)}</p><p class="question-context">Example: ${escape(q.sample.subject)}. Left unchanged.</p>${q.options.map(o => `<label class="question-option"><input type="radio" name="answer" value="${escape(o.id)}" required><span>${escape(o.label)}</span></label>`).join('')}<button class="primary" type="submit">Save my answer →</button><p>${q.initial ? 'Saved for this topic in your Primary sample and future cleanups.' : 'Saved for this topic in future cleanups. Earlier emails left waiting stay unchanged.'}</p></form>`).join('') : empty('You’re all caught up.', 'Questions about uncertain mail will wait here. The agent leaves those emails alone.');
  const labels = { keep: 'Keep in inbox', read: 'Mark low-priority mail read', archive: 'Archive low-priority mail', both: 'Mark read and archive low-priority mail', unsubscribe: 'Unsubscribe from unwanted marketing on this list' };
  $('#learned-preferences').innerHTML = learningState.memories.length ? learningState.memories.map(m => `<form class="memory-card" data-memory="${escape(m.id)}"><strong>${escape(m.scope.label || m.scope.listId || m.scope.sender)}</strong><p>${escape(m.explanation)}</p><label>Future handling<select name="action">${Object.entries(labels).filter(([action]) => action !== 'unsubscribe' || m.scope.listId).map(([action, label]) => `<option value="${action}" ${action === m.action ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label>Only after this many days<input name="minAgeDays" type="number" min="${m.scope.minimumAgeDays || 0}" max="3650" value="${m.minAgeDays || m.scope.minimumAgeDays || 0}"></label><label>Written conditions<textarea name="instructions" maxlength="2000" rows="3">${escape(m.instructions || '')}</textarea></label><div class="agent-actions"><button class="secondary" type="submit">Save change</button><button class="text-button" type="button" data-remove-memory="${escape(m.id)}">Forget this preference</button></div><small>Version ${number(m.version)} · still follows your allowed actions and protections.</small></form>`).join('') : '<p>As you answer questions, your preferences appear here.</p>';
  $('#questions-tray').querySelectorAll('[data-question]').forEach(form => {
    const question = learningState.questions.find(question => question.id === form.dataset.question);
    const write = document.createElement('button'); write.type = 'button'; write.className = 'text-button'; write.textContent = 'Or write my own answer'; form.append(write);
    write.onclick = () => {
      const hidden = [...form.querySelectorAll('.question-option'), form.querySelector('button')]; hidden.forEach(element => { element.hidden = true; }); write.hidden = true;
      const custom = document.createElement('div'); form.append(custom);
      writePreference(custom, { question, request, onSaved: () => loadLearning(), onCancel: () => { custom.remove(); hidden.forEach(element => { element.hidden = false; }); write.hidden = false; } });
    };
  });
  renderDiscovery(learningState.discovery);
  if (state?.connected) renderExceptions();
}
$('#questions-tray').addEventListener('submit', event => {
  event.preventDefault(); const form = event.target.closest('[data-question]'); if (!form) return;
  const question = learningState.questions.find(q => q.id === form.dataset.question); const option = new FormData(form).get('answer');
  operation(form.querySelector('button'), 'Saving…', async () => { await request('/api/agent/questions/answer', { questionId: question.id, version: question.version, option }); await loadLearning(); if (question.initial && !learningState.questions.length && state.rules.agent?.enabled) showPage('overview'); toast(option === 'later' ? 'Question saved for tomorrow. Emails left unchanged.' : question.initial ? 'Setup answer saved. Start your free cleanup from Overview when ready.' : 'Preference saved for future mail. Earlier emails left unchanged.'); });
});
$('#learned-preferences').addEventListener('submit', event => {
  event.preventDefault(); const form = event.target.closest('[data-memory]'); if (!form) return;
  const memory = learningState.memories.find(m => m.id === form.dataset.memory);
  operation(form.querySelector('button'), 'Saving…', async () => { await request('/api/agent/memories/edit', { memoryId: memory.id, version: memory.version, action: new FormData(form).get('action'), minAgeDays: Number(new FormData(form).get('minAgeDays')), instructions: new FormData(form).get('instructions') }); await loadLearning(); toast('Preference updated for future mail.'); });
});
$('#learned-preferences').addEventListener('click', event => {
  const button = event.target.closest('[data-remove-memory]'); if (!button) return;
  const memory = learningState.memories.find(m => m.id === button.dataset.removeMemory);
  operation(button, 'Removing…', async () => { await request('/api/agent/memories/edit', { memoryId: memory.id, version: memory.version, remove: true }); await loadLearning(); toast('Preference removed. Earlier held emails stay unchanged.'); });
});
setInterval(() => { if (state?.connected && !busy && !document.hidden) loadLearning().catch(() => {}); }, 60000);

function renderExceptions() {
  const previous = $('#exception-category').value;
  const available = { ...state.preferenceCategories };
  for (const item of [...learningState.memories, ...learningState.questions]) if (item.scope?.kind === 'category') available[item.scope.category] = { label: item.scope.label };
  $('#exception-category').replaceChildren(new Option('All mail from this sender', 'all'), ...Object.entries(available).map(([key, item]) => new Option(item.label, key)));
  if ([...$('#exception-category').options].some(o => o.value === previous)) $('#exception-category').value = previous;
  const labels = { keep: 'Keep in inbox', read: 'Mark read; keep in inbox', archive: 'Archive', both: 'Mark read and archive' };
  $('#sender-exceptions').innerHTML = (state.rules.agent?.exceptionsRules || []).map(rule => `<div class="list-row"><div class="row-main"><strong>${escape(rule.value)}</strong><p>${escape(available[rule.category]?.label || 'All mail')} · ${escape(labels[rule.action])}</p></div><button class="text-button" type="button" data-remove-exception="${escape(rule.id)}">Remove exception</button></div>`).join('');
}
$('#exception-form').addEventListener('submit', event => {
  event.preventDefault();
  const rule = { id: crypto.randomUUID(), type: $('#exception-type').value, value: $('#exception-value').value, category: $('#exception-category').value, action: $('#exception-action').value };
  operation($('#exception-save'), 'Saving…', async () => {
    const latest = await request('/api/status');
    await request('/api/rules', { ...latest.rules, agent: { ...latest.rules.agent, exceptionsRules: [...(latest.rules.agent?.exceptionsRules || []), rule] } });
    await refresh(); $('#exception-value').value = ''; toast('Exception saved. Your general preference stays the same.');
  });
});
$('#sender-exceptions').addEventListener('click', event => {
  const button = event.target.closest('[data-remove-exception]'); if (!button) return;
  operation(button, 'Removing…', async () => {
    const latest = await request('/api/status');
    await request('/api/rules', { ...latest.rules, agent: { ...latest.rules.agent, exceptionsRules: (latest.rules.agent?.exceptionsRules || []).filter(rule => rule.id !== button.dataset.removeException) } });
    await refresh(); toast('Exception removed. The general category preference applies again.');
  });
});
