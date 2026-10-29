import test from 'node:test';
import assert from 'node:assert/strict';
import { traced, timed, setRunId, traceFields, queryFields } from '../server/telemetry.js';

test('parallel workflows retain isolated run IDs and failure timings never expose payloads', async t => {
  const original = console.info;
  const logs = [];
  console.info = value => logs.push(JSON.parse(value));
  t.after(() => {
    console.info = original;
  });
  await Promise.all(
    ['one', 'two'].map(runId =>
      traced('fixture', async () => {
        setRunId(runId);
        await timed(
          'db.query',
          async () => {
            await Promise.resolve();
            assert.equal(traceFields().runId, runId);
          },
          queryFields('SELECT secret FROM accounts WHERE id=?')
        );
        await assert.rejects(
          timed('google.request', async () => {
            throw new Error('private email body and token');
          })
        );
      })
    )
  );
  const summaries = logs.filter(row => row.event === 'workflow_complete');
  assert.equal(summaries.length, 2);
  assert.notEqual(summaries[0].traceId, summaries[1].traceId);
  for (const row of summaries) {
    assert.equal(row.operations['db.query'].count, 1);
    assert.equal(row.operations['google.request'].failures, 1);
  }
  assert.doesNotMatch(JSON.stringify(logs), /private email|secret|SELECT secret|WHERE|token/);
});
