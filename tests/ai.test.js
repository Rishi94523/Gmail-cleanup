import test from 'node:test';
import assert from 'node:assert/strict';
import { aiConfig, chatJSON } from '../server/ai.js';
import { ASK_PREFERENCE_TOOL } from '../server/learning.js';

test('provider flag isolates keys and model settings; legacy settings apply only to OpenRouter', () => {
  const env = { NEBIUS_API_KEY: 'nebius-fixture', AI_API_KEY: 'legacy-router-fixture', AI_MODEL: 'legacy/model' };
  assert.deepEqual(aiConfig({ ...env, AI_PROVIDER: 'nebius' }), { aiProvider: 'nebius', aiKey: 'nebius-fixture', aiModel: 'nvidia/Nemotron-3.5-Super-VL' });
  assert.deepEqual(aiConfig(env), { aiProvider: 'openrouter', aiKey: 'legacy-router-fixture', aiModel: 'legacy/model' });
  assert.equal(aiConfig({ ...env, OPENROUTER_API_KEY: 'preferred-fixture', OPENROUTER_MODEL: 'another/model' }).aiKey, 'preferred-fixture');
  assert.equal(aiConfig({ AI_PROVIDER: 'nebius', OPENROUTER_API_KEY: 'router-fixture' }).aiKey, '');
  assert.throws(() => aiConfig({ AI_PROVIDER: 'unknown' }), /AI_PROVIDER/);
});
for (const provider of ['nebius', 'openrouter']) test(`${provider} requests use the selected endpoint, model, bearer key and JSON contract`, async () => {
  const config = aiConfig({ AI_PROVIDER: provider, NEBIUS_API_KEY: 'nebius-fixture', OPENROUTER_API_KEY: 'router-fixture' });
  let calls = 0;
  const result = await chatJSON(config, [{ role: 'user', content: 'Return JSON.' }], async (url, options) => {
    calls++;
    assert.equal(url, provider === 'nebius' ? 'https://api.tokenfactory.us-north1.nebius.com/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(options.headers.Authorization, `Bearer ${config.aiKey}`);
    const body = JSON.parse(options.body); assert.equal(body.model, config.aiModel); assert.equal(body.response_format.type, 'json_object');
    for (const field of ['max_tokens', 'max_completion_tokens', 'chat_template_kwargs', 'reasoning', 'reasoning_effort']) assert.equal(Object.hasOwn(body, field), false);
    assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"action":"keep"}' } }] });
  });
  assert.deepEqual(result, { action: 'keep' }); assert.equal(calls, 1);
});
test('provider errors never leak raw bodies or keys and never fallback to another provider', async () => {
  const config = aiConfig({ AI_PROVIDER: 'nebius', NEBIUS_API_KEY: 'secret-fixture-value' }); let calls = 0;
  await assert.rejects(chatJSON(config, [], async () => { calls++; return Response.json({ error: 'secret-fixture-value' }, { status: 401 }); }), error => /Nebius.*401/.test(error.message) && !error.message.includes('secret-fixture-value'));
  assert.equal(calls, 1);
  await assert.rejects(chatJSON(config, [], async () => { throw new Error('secret-fixture-value'); }), error => !error.message.includes('secret-fixture-value'));
});
for (const provider of ['nebius', 'openrouter']) test(`${provider} preference tool calls retain default reasoning and output budgets`, async () => {
  const config = aiConfig({ AI_PROVIDER: provider, NEBIUS_API_KEY: 'fixture', OPENROUTER_API_KEY: 'fixture' });
  const args = { category: 'product_announcements', question: 'How should I handle product announcements?', reason: 'Preference unknown.' };
  const result = await chatJSON(config, [], async (_url, options) => {
    const body = JSON.parse(options.body);
    for (const field of ['max_tokens', 'max_completion_tokens', 'chat_template_kwargs', 'reasoning', 'reasoning_effort']) assert.equal(Object.hasOwn(body, field), false);
    assert.deepEqual(body.tools, [ASK_PREFERENCE_TOOL]);
    assert.equal(body.tool_choice, 'auto');
    return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ function: { name: 'ask_preference', arguments: JSON.stringify(args) } }] } }] });
  }, [ASK_PREFERENCE_TOOL]);
  assert.deepEqual(result, { requestPreference: args });
});
test('missing selected key does not send requests; malformed and truncated output cannot become decisions', async () => {
  let called = false;
  await assert.rejects(chatJSON(aiConfig({ AI_PROVIDER: 'nebius', AI_API_KEY: 'router-fixture' }), [], async () => { called = true; }), /NEBIUS_API_KEY/);
  assert.equal(called, false);
  const config = aiConfig({ NEBIUS_API_KEY: 'fixture', AI_PROVIDER: 'nebius' });
  for (const choice of [{ finish_reason: 'length', message: { content: '{"action":"read"}' } }, { finish_reason: 'stop', message: { content: 'not JSON' } }, { finish_reason: 'stop', message: { content: '[]' } }]) {
    await assert.rejects(chatJSON(config, [], async () => Response.json({ choices: [choice] })), error => choice.finish_reason === 'length' ? error.publicCode === 'AI_TRUNCATED' : error.publicCode === 'AI_INVALID_OUTPUT');
  }
});
