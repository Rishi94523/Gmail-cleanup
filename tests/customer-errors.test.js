import test from 'node:test';
import assert from 'node:assert/strict';
import { failure, publicFailure } from '../server/failures.js';
import { customerMessage } from '../public/customer-message.js';

test('AI failure codes remain diagnosable without exposing provider errors to customers', () => {
  for (const code of ['AI_TRUNCATED', 'AI_INVALID_OUTPUT', 'AI_UNAVAILABLE', 'AI_HTTP_401']) {
    const result = publicFailure(failure(code, 'Nebius Token Factory: private diagnostic'));
    assert.equal(result.code, code);
    assert.doesNotMatch(result.message, /Nebius|Factory|diagnostic|401|JSON|API/);
    assert.match(result.message, /left unchanged/);
  }
});

test('historical system errors are safe to display while ordinary guidance is preserved', () => {
  for (const text of [
    'OpenRouter failed (401)',
    'Configure NEBIUS_API_KEY',
    'Nebius Token Factory reached its response limit'
  ]) {
    assert.doesNotMatch(customerMessage(text), /OpenRouter|Nebius|API_KEY|response limit|401/);
  }
  assert.equal(customerMessage('Choose an action for this topic.'), 'Choose an action for this topic.');
});
