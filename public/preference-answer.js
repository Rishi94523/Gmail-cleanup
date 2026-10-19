const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const actions = { keep: 'Keep unchanged', read: 'Mark as read', archive: 'Archive', both: 'Mark read and archive' };

export function writePreference(container, { question, request, onSaved, onCancel }) {
  let text = ''; let proposal; let busy = false;
  function render(message = '') {
    container.innerHTML = `<div class="custom-answer"><label>Your answer<textarea aria-label="Your written preference" maxlength="2000" rows="3" ${proposal ? 'readonly' : ''} placeholder="For example: mark these read after 90 days, but keep unusual activity alerts.">${escape(text)}</textarea></label>${proposal ? `<p class="custom-summary"><strong>${escape(actions[proposal.action])}</strong> · ${proposal.minAgeDays ? `only after ${proposal.minAgeDays} days` : 'no age threshold'}</p><p class="custom-hint">Your written conditions will also guide the agent. Protected mail stays protected.</p>` : '<p class="custom-hint">Describe the action, age, and any exceptions. You’ll confirm before it’s saved.</p>'}<p class="custom-error" role="status">${escape(message)}</p><div class="custom-buttons"><button type="button" class="primary" data-custom-submit>${proposal ? 'Save this preference' : 'Understand my answer'} →</button><button type="button" class="text-button" data-custom-back>${proposal ? 'Edit answer' : 'Back to choices'}</button></div></div>`;
    const field = container.querySelector('textarea'); field.oninput = () => { text = field.value; };
    container.querySelector('[data-custom-back]').onclick = () => { if (busy) return; if (proposal) { proposal = null; render(); } else onCancel(); };
    container.querySelector('[data-custom-submit]').onclick = async () => {
      if (busy) return;
      if (!text.trim()) return render('Write your preference first.');
      busy = true; container.querySelectorAll('button,textarea').forEach(element => { element.disabled = true; });
      try {
        if (proposal) {
          await request('/api/agent/questions/answer', { questionId: question.id, version: question.version, option: 'custom', action: proposal.action, minAgeDays: proposal.minAgeDays, instructions: text.trim() });
          await onSaved();
        } else {
          const result = await request('/api/agent/questions/interpret', { questionId: question.id, version: question.version, text: text.trim() });
          busy = false;
          if (!result.supported) return render(result.clarification);
          proposal = result; render();
        }
      } catch (error) { busy = false; render(error.message); }
    };
    if (!proposal) field.focus({ preventScroll: true });
  }
  render();
}
