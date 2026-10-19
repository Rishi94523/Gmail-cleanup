const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function createOnboarding({ getState, request, refresh, startAgent, showPage }) {
  const root = document.createElement('section');
  root.id = 'onboarding'; root.hidden = true; root.setAttribute('aria-label', 'Set up your inbox agent');
  root.innerHTML = `<header class="ob-header"><a class="wordmark" href="/">inboxclean<span class="brand-dot">.</span></a><span class="ob-connected"><i></i> Gmail connected</span></header><main class="ob-main"><div class="ob-panel" id="ob-panel"></div></main><footer class="ob-footer">Your first 100 emails. Your say in what stays.</footer>`;
  document.body.append(root);
  const panel = root.querySelector('#ob-panel');
  let active = false; let working = false; let discovery; let question; let answered = 0; let total = 0; let finalAction = 'read'; let complete;
  const provider = () => getState().aiProvider === 'nebius' ? 'Nebius Token Factory' : 'OpenRouter and your selected model provider';
  const motion = (thinking = false) => `<div class="ob-agents ${thinking ? 'thinking' : ''}" aria-hidden="true"><span class="ob-orbit"></span><span class="ob-agent ob-reader">✉</span><span class="ob-agent ob-thinker"><i></i><i></i><i></i></span><span class="ob-agent ob-spark">✧</span></div>`;
  function render(content, thinking = false) { panel.innerHTML = `${motion(thinking)}<div class="ob-content">${content}</div>`; panel.classList.remove('ob-enter'); void panel.offsetWidth; panel.classList.add('ob-enter'); panel.querySelector('h1')?.setAttribute('tabindex', '-1'); panel.querySelector('h1')?.focus({ preventScroll: true }); }
  function thinking(title, text) { render(`<p class="ob-kicker">YOUR AGENT IS ON IT</p><h1>${escape(title)}</h1><p class="ob-copy">${escape(text)}</p><div class="ob-thinking-line" role="status" aria-live="polite"><i></i> Reading patterns. Connecting the dots.</div>`, true); }
  function fail(error, duringCleanup = false) {
    working = false;
    render(`<p class="ob-kicker">LET’S PAUSE HERE</p><h1>Your inbox can wait.</h1><p class="ob-copy">${escape(error.message)}</p><p class="ob-detail">${duringCleanup ? 'Some changes may already be recorded. Check Activity before trying again.' : 'No cleanup has started. Your emails are unchanged.'}</p><button class="primary ob-primary" id="ob-dashboard">${duringCleanup ? 'Check activity' : 'Open my workspace'} →</button>`);
    panel.querySelector('button').onclick = () => close(duringCleanup ? 'activity' : 'overview');
  }
  function close(page = 'overview') { active = false; root.hidden = true; document.body.classList.remove('onboarding-open'); showPage(page); }
  function intro() {
    render(`<p class="ob-kicker">CONNECTED. NOW, LET’S GET ACQUAINTED.</p><h1>A little thinking.<br>A lighter inbox.</h1><p class="ob-copy">Your agent will look through up to 100 unread emails, find the patterns, and ask what matters to you.</p><label class="ob-consent"><input id="ob-consent" type="checkbox"><span>Allow AI to analyze my email</span></label><p class="ob-detail">${escape(provider())} receives sender and subject samples, then up to 12,000 characters per email during cleanup. No attachments. Nothing changes until you say go.</p><button class="primary ob-primary" id="ob-discover" disabled>Let my agent look →</button>`);
    const consent = panel.querySelector('input'); const button = panel.querySelector('button');
    consent.onchange = () => { button.disabled = !consent.checked || !getState().aiConfigured; };
    button.onclick = () => discover();
  }
  async function discover() {
    if (working) return; working = true;
    thinking('Getting to know your inbox.', 'Looking for recurring topics and the mail you might want to keep. No emails are being changed.');
    try {
      const state = getState();
      await request('/api/rules', { ...state.rules, daily: false, aiEnabled: false, agent: { ...state.rules.agent, enabled: false, consent: true, consentProvider: state.aiProvider } });
      discovery = await request('/api/agent/learn', { consent: true, provider: state.aiProvider });
      await refresh(); working = false; await nextQuestion();
    } catch (error) { fail(error); }
  }
  async function nextQuestion() {
    const tray = await request('/api/agent/questions');
    const supported = new Set(discovery?.evidenceCategories || []);
    const questions = tray.questions.filter(q => supported.has(q.scope.category));
    total = Math.max(total, answered + questions.length);
    question = questions[0];
    if (!question) return review();
    render(`<p class="ob-kicker">FROM YOUR INBOX · ${answered + 1} OF ${total}</p><h1>${escape(question.question)}</h1><p class="ob-copy ob-evidence">${escape(question.reason)}</p><form id="ob-question"><div class="ob-options">${question.options.map(o => `<label class="ob-option"><input type="radio" name="answer" value="${escape(o.id)}" required><span>${escape(o.id === 'keep' ? 'Keep these in my inbox' : o.id === 'later' ? 'Leave these alone for now' : o.id === 'unsubscribe' ? o.label : 'Tidy low-priority emails like these')}</span><span class="ob-option-check" aria-hidden="true">✓</span></label>`).join('')}</div><button class="primary ob-primary" type="submit">Continue →</button></form><p class="ob-detail">One preference across senders. You can add exceptions later.</p>`);
    panel.querySelector('form').onsubmit = async event => {
      event.preventDefault(); if (working) return; working = true;
      const button = panel.querySelector('button'); button.disabled = true; button.textContent = 'Remembering…';
      try { await request('/api/agent/questions/answer', { questionId: question.id, version: question.version, option: new FormData(event.target).get('answer') }); answered++; working = false; await nextQuestion(); }
      catch (error) { fail(error); }
    };
  }
  function review() {
    render(`<p class="ob-kicker">WE’VE GOT THE PICTURE</p><h1>How shall I tidy up?</h1><p class="ob-copy">I’ll use your answers to decide what matters. Important mail and anything uncertain will stay.</p><div class="ob-options ob-actions">${[['read','Mark as read','Keep it in the inbox, without the unread badge.'],['archive','Archive','Move it out of the inbox. Still there in All Mail.'],['both','Mark read & archive','A quieter inbox and unread count.']].map(([value,label,detail]) => `<label class="ob-option"><input type="radio" name="cleanup-action" value="${value}" ${value === finalAction ? 'checked' : ''}><span><strong>${label}</strong><small>${detail}</small></span><span class="ob-option-check" aria-hidden="true">✓</span></label>`).join('')}</div><button class="primary ob-primary" id="ob-start">Clean my first 100 →</button><p class="ob-detail">Only low-priority mail. Nothing deleted. Changes can be undone.</p>`);
    panel.querySelectorAll('input').forEach(input => { input.onchange = () => { finalAction = input.value; }; });
    panel.querySelector('button').onclick = clean;
  }
  async function clean() {
    if (working) return; working = true;
    thinking('Making a little room.', 'Your agent is reading each email and following your preferences.');
    try {
      const state = getState(); const tray = await request('/api/agent/questions');
      const categories = new Map(tray.memories.filter(m => m.scope.kind === 'category').map(m => [m.scope.category, m.action]));
      const agent = { ...state.rules.agent, enabled: true, consent: true, consentProvider: state.aiProvider, action: finalAction, ...(categories.has('job_opportunities') ? { keepJobs: categories.get('job_opportunities') === 'keep' } : {}), ...(categories.has('newsletters') ? { keepNewsletters: categories.get('newsletters') === 'keep' } : {}) };
      await request('/api/rules', { ...state.rules, agent, daily: false, aiEnabled: false });
      for (const memory of tray.memories) if (memory.initialSampleIds?.length && ['read','archive','both'].includes(memory.action) && memory.action !== finalAction) await request('/api/agent/memories/edit', { memoryId: memory.id, version: memory.version, action: finalAction });
      await refresh();
      await startAgent(event => {
        if (event.type === 'decision') {
          const copy = panel.querySelector('.ob-copy'); copy.textContent = `${event.inspected} checked · ${event.changed} tidied · ${event.kept} kept`;
          panel.querySelector('.ob-thinking-line').textContent = ({ read: 'Marked a low-priority email as read.', archive: 'Archived a low-priority email.', both: 'Marked read and archived.', keep: 'Kept an email in place.', unsubscribe: 'Submitted an approved unsubscribe request.' })[event.action] || 'Considering what matters.';
        }
        if (event.type === 'complete') complete = event;
      });
      working = false;
      render(`<p class="ob-kicker">A LITTLE MORE HEADSPACE</p><h1>Your first fresh start.</h1><p class="ob-copy">${complete?.inspected || 0} emails checked. ${complete?.changed || 0} tidied. ${complete?.kept || 0} kept.</p><p class="ob-detail">Uncertain emails stayed put. Your preferences, activity, and undo are waiting in your workspace.</p><button class="primary ob-primary" id="ob-dashboard">Open my workspace →</button>`);
      panel.querySelector('button').onclick = () => close();
    } catch (error) { fail(error, true); }
  }
  return {
    get active() { return active; },
    async open() {
      active = true; root.hidden = false; document.body.classList.add('onboarding-open');
      const state = getState();
      if (state.rules.agent?.consent && state.rules.agent.consentProvider === state.aiProvider) await discover(); else intro();
    }
  };
}
