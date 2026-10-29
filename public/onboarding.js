import { customerMessage } from './customer-message.js';
import { writePreference, writeNotes } from './preference-answer.js';
const escape = value =>
  String(value ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

export function createOnboarding({ getState, request, refresh, startAgent, showPage }) {
  const root = document.createElement('section');
  root.id = 'onboarding';
  root.hidden = true;
  root.setAttribute('aria-label', 'Set up your inbox agent');
  root.innerHTML = `<header class="ob-header"><a class="wordmark" href="/">inboxclean<span class="brand-dot">.</span></a><span class="ob-connected"><i></i> Gmail connected</span></header><main class="ob-main"><div class="ob-panel" id="ob-panel"></div></main><footer class="ob-footer">Your first 100 unread emails in Primary.</footer>`;
  document.body.append(root);
  const panel = root.querySelector('#ob-panel');
  let active = false;
  let working = false;
  let discovery;
  let question;
  let answered = 0;
  let total = 0;
  let reviewPage = 0;
  let complete;
  const motion = (thinking = false) =>
    `<div class="ob-agents ${thinking ? 'thinking' : ''}" aria-hidden="true"><span class="ob-orbit"></span><span class="ob-agent ob-reader">✉</span><span class="ob-agent ob-thinker"><i></i><i></i><i></i></span><span class="ob-agent ob-spark">✧</span></div>`;
  function render(content, thinking = false) {
    panel.innerHTML = `${motion(thinking)}<div class="ob-content">${content}</div>`;
    panel.classList.remove('ob-enter');
    void panel.offsetWidth;
    panel.classList.add('ob-enter');
    panel.querySelector('h1')?.setAttribute('tabindex', '-1');
    panel.querySelector('h1')?.focus({ preventScroll: true });
  }
  function thinking(title, text) {
    render(
      `<p class="ob-kicker">YOUR AGENT IS ON IT</p><h1>${escape(title)}</h1><p class="ob-copy">${escape(text)}</p><div class="ob-thinking-line" role="status" aria-live="polite"><i></i> Reading patterns. Connecting the dots.</div>`,
      true
    );
  }
  function fail(error, duringCleanup = false) {
    working = false;
    render(
      `<p class="ob-kicker">LET’S PAUSE HERE</p><h1>Your inbox can wait.</h1><p class="ob-copy">${escape(duringCleanup ? customerMessage(error.message) : 'We couldn’t finish learning your preferences. Please try again later.')}</p><p class="ob-detail">${duringCleanup ? 'Some changes may already be recorded. Check Activity before trying again.' : 'No cleanup has started. Your emails are unchanged.'}</p><button class="primary ob-primary" id="ob-dashboard">${duringCleanup ? 'Check activity' : 'Open my workspace'} →</button>`
    );
    panel.querySelector('button').onclick = () => close(duringCleanup ? 'activity' : 'overview');
  }
  function close(page = 'overview') {
    active = false;
    root.hidden = true;
    document.body.classList.remove('onboarding-open');
    showPage(page);
  }
  function intro() {
    const repair = getState().access?.recoveryAvailable;
    render(
      `<p class="ob-kicker">${repair ? 'YOUR EARLIER RUN MADE NO CHANGES' : 'CONNECTED. NOW, LET’S GET ACQUAINTED.'}</p><h1>${repair ? 'Let’s take another look.' : 'A little thinking.<br>A lighter inbox.'}</h1><p class="ob-copy">${repair ? 'Review the original sample with the updated agent, including emails previously left waiting. Your saved preferences stay.' : 'Your agent will look at the subjects, senders and dates of up to 100 unread emails in Primary, then ask what matters to you.'}</p><label class="ob-consent"><input id="ob-consent" type="checkbox"><span>${repair ? 'Reassess my original sample with AI' : 'Allow AI to analyze my email'}</span></label><p class="ob-detail">Our AI service analyzes subjects, sender details and dates to suggest preferences. Email text is shared only during cleanup. No attachments. Nothing changes until you approve your preferences and start cleanup.</p><button class="primary ob-primary" id="ob-discover" disabled>${repair ? 'Review my questions again' : 'Let my agent look'} →</button>`
    );
    const consent = panel.querySelector('input');
    const button = panel.querySelector('button');
    consent.onchange = () => {
      button.disabled = !consent.checked || !getState().aiConfigured;
    };
    button.onclick = async () => {
      if (repair) {
        button.disabled = true;
        try {
          await request('/api/agent/reassess-trial', { authorize: true });
          await refresh();
        } catch (error) {
          return fail(error);
        }
      }
      await discover();
    };
  }
  async function discover() {
    if (working) return;
    working = true;
    thinking(
      'Getting to know your inbox.',
      'Looking for recurring topics and the mail you might want to keep. No emails are being changed.'
    );
    try {
      const state = getState();
      await request('/api/rules', {
        ...state.rules,
        aiEnabled: false,
        agent: {
          ...state.rules.agent,
          enabled: false,
          topicActions: true,
          consent: true,
          consentProvider: state.aiProvider
        }
      });
      discovery = await request('/api/agent/learn', { consent: true, provider: state.aiProvider });
      await refresh();
      working = false;
      await nextQuestion();
    } catch (error) {
      fail(error);
    }
  }
  async function nextQuestion() {
    const tray = await request('/api/agent/questions');
    const supported = new Set(discovery?.evidenceCategories || []);
    const questions = tray.questions.filter(q => supported.has(q.scope.category));
    total = Math.max(total, answered + questions.length);
    question = questions[0];
    if (!question) return review();
    render(
      `<p class="ob-kicker">FROM YOUR INBOX · ${answered + 1} OF ${total}</p><h1>${escape(question.question)}</h1><p class="ob-copy ob-evidence">${escape(question.reason)}</p><form id="ob-question"><div class="ob-options ob-topic-options">${question.options.map(o => `<label class="ob-option"><input type="radio" name="answer" value="${escape(o.id)}" required><span>${escape({ keep: 'Keep in inbox', read: 'Mark as read', archive: 'Archive', both: 'Read & archive', later: 'Decide later', unsubscribe: 'Unsubscribe' }[o.id] || o.label)}</span><span class="ob-option-check" aria-hidden="true">✓</span></label>`).join('')}</div><button class="primary ob-primary" type="submit">Continue →</button></form><p class="ob-detail">This action applies to this topic only. Nothing is deleted.</p>`
    );
    panel.querySelector('form').onsubmit = async event => {
      event.preventDefault();
      if (working) return;
      working = true;
      const button = panel.querySelector('button');
      button.disabled = true;
      button.textContent = 'Remembering…';
      try {
        await request('/api/agent/questions/answer', {
          questionId: question.id,
          version: question.version,
          option: new FormData(event.target).get('answer')
        });
        answered++;
        working = false;
        await nextQuestion();
      } catch (error) {
        fail(error);
      }
    };
    const write = document.createElement('button');
    write.type = 'button';
    write.className = 'text-button ob-write-answer';
    write.textContent = 'Or write my own answer';
    panel.querySelector('form').after(write);
    write.onclick = () => {
      write.remove();
      const form = panel.querySelector('form');
      const container = document.createElement('div');
      form.replaceWith(container);
      writePreference(container, {
        question,
        request,
        onSaved: async () => {
          answered++;
          await nextQuestion();
        },
        onCancel: () => nextQuestion().catch(fail)
      });
    };
  }
  async function review() {
    const tray = await request('/api/agent/questions');
    const memories = tray.memories.filter(m => m.scope.kind === 'category');
    const labels = { keep: 'Keep in inbox', read: 'Mark as read', archive: 'Archive', both: 'Read & archive' };
    const pages = Math.max(1, Math.ceil(memories.length / 3));
    reviewPage = Math.min(reviewPage, pages - 1);
    const lastPage = reviewPage === pages - 1;
    const visible = memories.slice(reviewPage * 3, reviewPage * 3 + 3);
    render(
      `<p class="ob-kicker">REVIEW YOUR PREFERENCES · ${reviewPage + 1} OF ${pages}</p><h1>Your preferences, ready.</h1><p class="ob-copy">Each topic follows its own action. Important, uncertain, and unclassified mail stays.</p><div class="ob-topic-summary">${
        visible.length
          ? visible
              .map(
                m =>
                  `<label class="ob-topic-row"><span>${escape(m.scope.label)}${m.minAgeDays ? `<small>Only after ${m.minAgeDays} days</small>` : ''}</span><select data-memory="${escape(m.id)}" aria-label="Action for ${escape(m.scope.label)}">${Object.entries(
                    labels
                  )
                    .map(
                      ([value, label]) =>
                        `<option value="${value}" ${m.action === value ? 'selected' : ''}>${label}</option>`
                    )
                    .join('')}</select></label>`
              )
              .join('')
          : '<p class="ob-detail">No topic preferences yet. The agent will leave uncertain mail untouched.</p>'
      }</div><div class="ob-review-navigation">${reviewPage > 0 ? '<button type="button" class="secondary" id="ob-prev">Previous preferences</button>' : ''}${lastPage ? '<button class="primary ob-primary" id="ob-start">Add final instructions →</button>' : '<button class="primary ob-primary" type="button" id="ob-next">Next preferences →</button>'}</div><p class="ob-detail">${lastPage ? 'All preference pages reviewed. Next, add any final instructions.' : 'Review every preference page before adding final instructions.'} Nothing is deleted.</p>`
    );
    panel.querySelectorAll('select').forEach(select => {
      select.onchange = async () => {
        if (working) return;
        working = true;
        panel.querySelectorAll('select,button').forEach(el => {
          el.disabled = true;
        });
        const memory = memories.find(m => m.id === select.dataset.memory);
        try {
          await request('/api/agent/memories/edit', {
            memoryId: memory.id,
            version: memory.version,
            action: select.value
          });
          working = false;
          await review();
        } catch (error) {
          fail(error);
        }
      };
    });
    if (panel.querySelector('#ob-prev'))
      panel.querySelector('#ob-prev').onclick = () => {
        reviewPage--;
        review().catch(fail);
      };
    if (panel.querySelector('#ob-next'))
      panel.querySelector('#ob-next').onclick = () => {
        reviewPage++;
        review().catch(fail);
      };
    if (lastPage) panel.querySelector('#ob-start').onclick = finalNotes;
  }
  function finalNotes() {
    render(
      '<p class="ob-kicker">BEFORE WE START</p><h1>Anything else we should know?</h1><p class="ob-copy">Add a preference, an exception, or a little context. You can change these later.</p><div id="ob-notes-composer"></div>'
    );
    writeNotes(panel.querySelector('#ob-notes-composer'), {
      request,
      initial: true,
      onSaved: async () => {
        await refresh();
        await clean();
      },
      onSkip: clean
    });
  }
  async function clean() {
    if (working) return;
    working = true;
    thinking('Making a little room.', 'Your agent is reading each email and following your preferences.');
    try {
      const state = getState();
      const tray = await request('/api/agent/questions');
      const categories = new Map(
        tray.memories.filter(m => m.scope.kind === 'category').map(m => [m.scope.category, m.action])
      );
      const agent = {
        ...state.rules.agent,
        enabled: true,
        consent: true,
        consentProvider: state.aiProvider,
        topicActions: true,
        ...(categories.has('job_opportunities') ? { keepJobs: categories.get('job_opportunities') === 'keep' } : {}),
        ...(categories.has('newsletters') ? { keepNewsletters: categories.get('newsletters') === 'keep' } : {})
      };
      // Daily cleanup is on by default once setup finishes; Preferences can turn it off.
      const daily = state.rules.daily || Boolean(state.access?.dailyAllowed && state.schedulerActive);
      await request('/api/rules', { ...state.rules, agent, aiEnabled: false, daily });
      await refresh();
      await startAgent(event => {
        if (event.type === 'stage') panel.querySelector('.ob-thinking-line').textContent = event.message;
        if (event.type === 'decision') {
          const copy = panel.querySelector('.ob-copy');
          copy.textContent = `${event.inspected} checked · ${event.changed} tidied · ${event.kept - (event.waiting || 0)} kept${event.waiting ? ` · ${event.waiting} need review` : ''}`;
          panel.querySelector('.ob-thinking-line').textContent = event.reason || 'Considering what matters.';
        }
        if (event.type === 'complete') complete = event;
      });
      working = false;
      render(
        `<p class="ob-kicker">${complete?.waiting ? 'SOME EMAILS STILL NEED YOUR INPUT' : 'CLEANUP COMPLETE'}</p><h1>${complete?.changed ? 'Your first fresh start.' : 'No emails were changed.'}</h1><p class="ob-copy">${complete?.inspected || 0} checked · ${complete?.changed || 0} tidied · ${(complete?.kept || 0) - (complete?.waiting || 0)} kept${complete?.waiting ? ` · ${complete.waiting} need review` : ''}</p><p class="ob-detail">${complete?.waiting ? 'Questions and uncertain classifications left emails untouched. See what the agent needs in your workspace.' : 'Your preferences, activity, and undo are waiting in your workspace.'}</p><button class="primary ob-primary" id="ob-dashboard">${complete?.waiting ? 'Review questions' : 'Open my workspace'} →</button>`
      );
      panel.querySelector('button').onclick = () => close(complete?.waiting ? 'questions' : 'overview');
    } catch (error) {
      fail(error, true);
    }
  }
  return {
    get active() {
      return active;
    },
    async open() {
      active = true;
      root.hidden = false;
      document.body.classList.add('onboarding-open');
      const state = getState();
      if (state.access?.recoveryAvailable) intro();
      else if (state.rules.agent?.consent && state.rules.agent.consentProvider === state.aiProvider) await discover();
      else intro();
    }
  };
}
