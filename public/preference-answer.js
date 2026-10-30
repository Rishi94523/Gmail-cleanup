const escape = value =>
  String(value ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
const actions = { keep: 'Keep unchanged', read: 'Mark as read', archive: 'Archive', both: 'Mark read and archive' };

export function answerCleanupMessage(result) {
  if (result?.cleanup?.status === 'failed')
    return 'Preference saved. Cleanup of held emails stopped; check Activity before retrying.';
  if (result?.cleanup?.status === 'completed')
    return `Preference saved. ${result.cleanup.inspected} held emails checked · ${result.cleanup.changed} tidied${result.cleanup.waiting ? ` · ${result.cleanup.waiting} still awaiting your answer` : ''}.`;
  return 'Preference saved. It applies to older and newer mail.';
}

export function writePreference(container, { question, request, onSaved, onCancel }) {
  let text = '';
  let history = [];
  let choices = [];
  let proposal;
  let busy = false;
  function render(message = '') {
    container.innerHTML = `<div class="custom-answer">${history.length && !proposal ? `<div class="clarification-thread" aria-label="Preference conversation">${history.map(turn => `<div class="clarification-user"><strong>You</strong><p>${escape(turn.answer)}</p></div><div class="clarification-agent"><strong>Your agent</strong><p>${escape(turn.question)}</p></div>`).join('')}</div>${choices.length ? `<div class="clarification-options" aria-label="Suggested replies">${choices.map((choice, index) => `<button type="button" class="secondary" data-reply="${index}">${escape(choice)}</button>`).join('')}</div>` : ''}` : ''}<label>${history.length ? 'Your reply' : 'Your answer'}<textarea aria-label="Your written preference" maxlength="2000" rows="3" ${proposal ? 'readonly' : ''} placeholder="For example: mark product announcements read after 15 days, but keep Apple announcements.">${escape(proposal?.instructions || text)}</textarea></label>${proposal ? `<p class="custom-summary"><strong>${escape(actions[proposal.action])}</strong> · ${proposal.minAgeDays ? `only after ${proposal.minAgeDays} days` : 'no age threshold'}</p><p class="custom-hint">Your written conditions will also guide the agent. Protected mail stays protected.</p>` : '<p class="custom-hint">Describe the action, age, and any exceptions. You’ll confirm before it’s saved.</p>'}<p class="custom-error" role="status">${escape(message)}</p><div class="custom-buttons"><button type="button" class="primary" data-custom-submit>${proposal ? 'Save this preference' : history.length ? 'Send reply' : 'Understand my answer'} →</button><button type="button" class="text-button" data-custom-back>${proposal ? 'Edit answer' : history.length ? 'Rewrite my answer' : 'Back to choices'}</button></div></div>`;
    const conversation = container.querySelector('.clarification-thread');
    if (conversation) conversation.scrollTop = conversation.scrollHeight;
    const field = container.querySelector('textarea');
    field.oninput = () => {
      text = field.value;
    };
    container.querySelectorAll('[data-reply]').forEach(button => {
      button.onclick = () => {
        if (busy) return;
        text = choices[Number(button.dataset.reply)];
        field.value = text;
        container.querySelector('[data-custom-submit]').click();
      };
    });
    container.querySelector('[data-custom-back]').onclick = () => {
      if (busy) return;
      if (proposal) {
        text = proposal.instructions;
        history = [];
        choices = [];
        proposal = null;
        render();
      } else if (history.length) {
        text = [...history.map(turn => turn.answer), text.trim()].filter(Boolean).join('\n');
        history = [];
        choices = [];
        render();
      } else onCancel();
    };
    container.querySelector('[data-custom-submit]').onclick = async () => {
      if (busy) return;
      if (!text.trim()) return render('Write your preference first.');
      const interpretation = history.length
        ? [
            ...history.map(turn => `User instructions: ${turn.answer}\nAgent follow-up: ${turn.question}`),
            `User reply: ${text.trim()}`
          ].join('\n')
        : text.trim();
      if (!proposal && interpretation.length > 2000)
        return render('This conversation is too long. Choose Rewrite my answer and shorten it before continuing.');
      busy = true;
      container.querySelectorAll('button,textarea').forEach(element => {
        element.disabled = true;
      });
      try {
        if (proposal) {
          container.querySelector('[data-custom-submit]').textContent = 'Saving & checking…';
          const result = await request('/api/agent/questions/answer', {
            questionId: question.id,
            version: question.version,
            option: 'custom',
            action: proposal.action,
            minAgeDays: proposal.minAgeDays,
            instructions: proposal.instructions
          });
          await onSaved(result);
        } else {
          const result = await request('/api/agent/questions/interpret', {
            questionId: question.id,
            version: question.version,
            text: interpretation
          });
          busy = false;
          if (!result.supported) {
            history.push({ answer: text.trim(), question: result.clarification });
            text = '';
            choices = Array.isArray(result.clarificationOptions) ? result.clarificationOptions : [];
            render();
            container.querySelector('textarea').focus();
            return;
          }
          proposal = { ...result, instructions: [...history.map(turn => turn.answer), text.trim()].join('\n') };
          render();
        }
      } catch (error) {
        busy = false;
        render(error.message);
      }
    };
    if (!proposal) field.focus({ preventScroll: true });
  }
  render();
}

export function writeNotes(container, { request, onSaved, onSkip, initial = false, fieldId }) {
  let text = '';
  const inputId = fieldId || (initial ? 'ob-notes' : 'preference-notes');
  let history = [];
  let choices = [];
  let proposal;
  let busy = false;
  function render(error = '') {
    container.innerHTML = `<form class="preference-composer">${history.length && !proposal ? `<div class="clarification-thread" aria-label="Preference conversation">${history.map(turn => `<div class="clarification-user"><strong>You</strong><p>${escape(turn.answer)}</p></div><div class="clarification-agent"><strong>Your agent</strong><p>${escape(turn.question)}</p></div>`).join('')}</div>${choices.length ? `<div class="clarification-options" aria-label="Suggested replies">${choices.map((choice, index) => `<button type="button" class="secondary" data-notes-reply="${index}">${escape(choice)}</button>`).join('')}</div>` : ''}` : ''}<label for="${inputId}">${history.length && !proposal ? 'Your reply' : initial ? 'Anything your agent should keep in mind?' : 'Add or change a preference'}</label><textarea id="${inputId}" rows="3" maxlength="2000" placeholder="For example: Archive product announcements after 15 days, but keep Apple announcements." ${proposal ? 'readonly' : ''}>${escape(text)}</textarea>${proposal ? `<div class="notes-preview" aria-live="polite"><p>Here’s what I’ll remember:</p><ul>${proposal.topics.map(t => `<li><strong>${escape(t.scope.label)}</strong> · ${escape(actions[t.action])}${t.minAgeDays ? ` after ${t.minAgeDays} days` : ''}${t.replaces ? ' · replaces your current choice' : ''}</li>`).join('')}${proposal.context ? `<li>Remember your background and interests</li>` : ''}</ul><p class="notes-conditions">${escape(text)}</p></div>` : ''}<p class="custom-error" role="alert">${escape(error)}</p><div class="custom-buttons"><button class="primary" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'Thinking…' : proposal ? 'Save these preferences' : history.length ? 'Send reply' : 'Review my instructions'} →</button>${proposal ? '<button class="text-button" type="button" data-edit-notes>Edit my words</button>' : onSkip ? `<button class="text-button" type="button" data-skip-notes>${initial ? 'Nothing else, start cleanup' : 'Cancel'}</button>` : ''}${history.length && !proposal ? '<button type="button" class="text-button" data-rewrite-notes>Rewrite my instructions</button>' : ''}</div><p class="custom-hint">${initial ? 'We’ll save your instructions before cleanup starts.' : 'If this answers a pending question, its held emails are rechecked immediately.'} Nothing is deleted.</p></form>`;
    const conversation = container.querySelector('.clarification-thread');
    if (conversation) conversation.scrollTop = conversation.scrollHeight;
    const form = container.querySelector('form');
    form.querySelectorAll('[data-notes-reply]').forEach(button => {
      button.onclick = () => {
        if (busy) return;
        text = choices[Number(button.dataset.notesReply)];
        form.querySelector('textarea').value = text;
        form.requestSubmit();
      };
    });
    const field = form.querySelector('textarea');
    field.oninput = () => {
      text = field.value;
    };
    form.querySelector('[data-rewrite-notes]')?.addEventListener('click', () => {
      text = [...history.map(turn => turn.answer), text.trim()].filter(Boolean).join('\n');
      history = [];
      choices = [];
      render();
    });
    form.querySelector('[data-edit-notes]')?.addEventListener('click', () => {
      text = proposal.instructions || text;
      proposal = null;
      history = [];
      choices = [];
      render();
    });
    form.querySelector('[data-skip-notes]')?.addEventListener('click', () => onSkip());
    form.onsubmit = async event => {
      event.preventDefault();
      if (busy) return;
      if (!text.trim()) {
        if (initial && onSkip && !history.length) return onSkip();
        return render('Write a preference first.');
      }
      const combined = [...history.map(turn => turn.answer), text.trim()].join('\n');
      if (!proposal && combined.length > 2000)
        return render('Please keep your combined instructions under 2000 characters.');
      busy = true;
      form.querySelectorAll('button,textarea').forEach(el => {
        el.disabled = true;
      });
      try {
        if (proposal) {
          form.querySelector('button[type=submit]').textContent = 'Saving & checking…';
          const result = await request('/api/agent/preferences/save', { token: proposal.token });
          busy = false;
          text = '';
          history = [];
          choices = [];
          proposal = null;
          await onSaved(result);
        } else {
          const result = await request('/api/agent/preferences/interpret', {
            text: combined,
            conversation: history.map(turn => ({ answer: turn.answer, question: turn.question }))
          });
          busy = false;
          if (!result.supported) {
            history.push({ answer: text.trim(), question: result.clarification });
            text = '';
            choices = result.clarificationOptions || [];
            render();
            container.querySelector('textarea').focus();
            return;
          }
          text = combined;
          proposal = { ...result, instructions: combined };
          render();
        }
      } catch (error) {
        busy = false;
        proposal = null;
        render(error.message);
      }
    };
  }
  render();
}
