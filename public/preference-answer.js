const escape = value =>
  String(value ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
const actions = { keep: 'Keep unchanged', read: 'Mark as read', archive: 'Archive', both: 'Mark read and archive' };

export function writePreference(container, { question, request, onSaved, onCancel }) {
  let text = '';
  let proposal;
  let busy = false;
  function render(message = '') {
    container.innerHTML = `<div class="custom-answer"><label>Your answer<textarea aria-label="Your written preference" maxlength="2000" rows="3" ${proposal ? 'readonly' : ''} placeholder="For example: mark these read after 90 days, but keep unusual activity alerts.">${escape(text)}</textarea></label>${proposal ? `<p class="custom-summary"><strong>${escape(actions[proposal.action])}</strong> · ${proposal.minAgeDays ? `only after ${proposal.minAgeDays} days` : 'no age threshold'}</p><p class="custom-hint">Your written conditions will also guide the agent. Protected mail stays protected.</p>` : '<p class="custom-hint">Describe the action, age, and any exceptions. You’ll confirm before it’s saved.</p>'}<p class="custom-error" role="status">${escape(message)}</p><div class="custom-buttons"><button type="button" class="primary" data-custom-submit>${proposal ? 'Save this preference' : 'Understand my answer'} →</button><button type="button" class="text-button" data-custom-back>${proposal ? 'Edit answer' : 'Back to choices'}</button></div></div>`;
    const field = container.querySelector('textarea');
    field.oninput = () => {
      text = field.value;
    };
    container.querySelector('[data-custom-back]').onclick = () => {
      if (busy) return;
      if (proposal) {
        proposal = null;
        render();
      } else onCancel();
    };
    container.querySelector('[data-custom-submit]').onclick = async () => {
      if (busy) return;
      if (!text.trim()) return render('Write your preference first.');
      busy = true;
      container.querySelectorAll('button,textarea').forEach(element => {
        element.disabled = true;
      });
      try {
        if (proposal) {
          await request('/api/agent/questions/answer', {
            questionId: question.id,
            version: question.version,
            option: 'custom',
            action: proposal.action,
            minAgeDays: proposal.minAgeDays,
            instructions: text.trim()
          });
          await onSaved();
        } else {
          const result = await request('/api/agent/questions/interpret', {
            questionId: question.id,
            version: question.version,
            text: text.trim()
          });
          busy = false;
          if (!result.supported) return render(result.clarification);
          proposal = result;
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

export function writeNotes(container, { request, onSaved, onSkip, initial = false }) {
  let text = '';
  let proposal;
  let busy = false;
  function render(error = '') {
    container.innerHTML = `<form class="preference-composer"><label for="${initial ? 'ob-notes' : 'preference-notes'}">${initial ? 'Anything your agent should keep in mind?' : 'Add or change a preference'}</label><textarea id="${initial ? 'ob-notes' : 'preference-notes'}" rows="3" maxlength="2000" placeholder="For example: Archive product announcements after 30 days, but keep Apple announcements." ${proposal ? 'readonly' : ''}>${escape(text)}</textarea>${proposal ? `<div class="notes-preview" aria-live="polite"><p>Here’s what I’ll remember:</p><ul>${proposal.topics.map(t => `<li><strong>${escape(t.scope.label)}</strong> · ${escape(actions[t.action])}${t.minAgeDays ? ` after ${t.minAgeDays} days` : ''}${t.replaces ? ' · replaces your current choice' : ''}</li>`).join('')}${proposal.context ? `<li>Remember your background and interests</li>` : ''}</ul><p class="notes-conditions">${escape(text)}</p></div>` : ''}<p class="custom-error" role="alert">${escape(error)}</p><div class="custom-buttons"><button class="primary" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'Thinking…' : proposal ? 'Save these preferences' : 'Review my instructions'} →</button>${proposal ? '<button class="text-button" type="button" data-edit-notes>Edit my words</button>' : onSkip ? `<button class="text-button" type="button" data-skip-notes>${initial ? 'Nothing else, start cleanup' : 'Cancel'}</button>` : ''}</div><p class="custom-hint">${initial ? 'We’ll save your instructions before cleanup starts.' : 'Saved preferences guide future cleanups. Earlier held emails stay unchanged.'} Nothing is deleted.</p></form>`;
    const form = container.querySelector('form');
    const field = form.querySelector('textarea');
    field.oninput = () => {
      text = field.value;
    };
    form.querySelector('[data-edit-notes]')?.addEventListener('click', () => {
      proposal = null;
      render();
    });
    form.querySelector('[data-skip-notes]')?.addEventListener('click', () => onSkip());
    form.onsubmit = async event => {
      event.preventDefault();
      if (busy) return;
      if (!text.trim()) {
        if (initial && onSkip) return onSkip();
        return render('Write a preference first.');
      }
      busy = true;
      form.querySelectorAll('button,textarea').forEach(el => {
        el.disabled = true;
      });
      try {
        if (proposal) {
          await request('/api/agent/preferences/save', { token: proposal.token });
          busy = false;
          text = '';
          proposal = null;
          await onSaved();
        } else {
          const result = await request('/api/agent/preferences/interpret', { text: text.trim() });
          busy = false;
          if (!result.supported) return render(result.clarification);
          proposal = result;
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
