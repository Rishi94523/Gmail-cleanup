import { aiConfig, chatJSON } from '../server/ai.js';

// Synthetic connectivity check only: never reads Gmail or changes mailbox state.
try {
  const config = aiConfig();
  const result = await chatJSON(config, [
    { role: 'system', content: 'Return exactly one JSON object: {"ready":true}. No other fields.' },
    { role: 'user', content: 'Synthetic connection check; no email data.' }
  ]);
  if (result.ready !== true) throw new Error('The provider responded, but the JSON contract check failed.');
  console.log(
    `PASS ${config.aiProvider} · ${config.aiModel}: authenticated synthetic JSON request. No Gmail accessed.`
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
