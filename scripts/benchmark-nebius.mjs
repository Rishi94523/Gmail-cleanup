import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { aiConfig, chatRequest } from '../server/ai.js';
import { AGENT_DECISION_INSTRUCTION, DEFAULT_PREFERENCES, batchPromptMessages } from '../server/agent.js';

// Explicitly synthetic: this script never opens the database or accesses Gmail.
const models = ['nvidia/Nemotron-3.5-Super-VL', 'nvidia/Nemotron-3-Ultra-550b-a55b'];
const rounds = Number(process.env.BENCHMARK_ROUNDS || 3);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw new Error('BENCHMARK_ROUNDS must be 1–10.');
const fixtures = [
  ['Your weekly engineering digest', 'newsletters', 'read', 'A weekly roundup of optional programming articles.'],
  ['New dashboard features are here', 'product_announcements', 'read', 'Optional product features and a product tour.'],
  [
    'Your free credits have expired',
    'topic_service_notices',
    'read',
    'Unused free trial credits expired. No payment is due.'
  ],
  ['Security alert: new sign-in', 'security_notices', 'keep', 'A new sign-in today. Please verify this was you.'],
  ['Welcome to Example Tools', 'topic_onboarding', 'read', 'Automated getting-started tips after account creation.'],
  [
    'Interview invitation for software engineer',
    'job_opportunities',
    'keep',
    'Please choose an interview time this week.'
  ],
  [
    'Your order was delivered',
    'topic_order_confirmations',
    'read',
    'A routine delivery confirmation for a completed order.'
  ],
  ['This week in your community', 'social_notifications', 'read', 'An optional digest of community discussions.'],
  [
    'Your weekly usage summary',
    'topic_service_notices',
    'read',
    'Informational usage statistics. No action or billing issue.'
  ],
  ['Product launch announcement', 'product_announcements', 'read', 'An optional announcement about a new product.']
];
const categoryPreferences = fixtures.map(([, category, action]) => ({
  scope: { kind: 'category', category },
  action,
  minAgeDays: category === 'security_notices' ? 30 : 0
}));
const messages = batchPromptMessages(
  AGENT_DECISION_INSTRUCTION,
  fixtures.map(([subject, category, , text], i) => ({
    id: `email_${i + 1}`,
    preferences: { ...DEFAULT_PREFERENCES, action: 'read', topicActions: true },
    userContext: 'Interested in software engineering roles. Keep interviews.',
    categoryPreferences,
    preferenceCategories: [...new Set(fixtures.map(f => f[1]))],
    learnedPreference: null,
    sender: `sender${i}@example.invalid`,
    subject,
    receivedAt: category === 'security_notices' ? '2026-10-30T08:00:00Z' : '2026-09-01T08:00:00Z',
    ageDays: category === 'security_notices' ? 0 : 59,
    currentClock: { now: '2026-10-30T10:00:00Z', currentDate: '2026-10-30', timezone: 'UTC' },
    text: `${text} `.repeat(25),
    history: []
  }))
);
const rounded = n => Number(n.toFixed(2));
const results = [];
async function sample(model, round) {
  const config = { ...aiConfig(), aiModel: model, aiReasoningEffort: 'medium' };
  const { url, body, requestedReasoningEffort } = chatRequest(config, messages);
  const start = performance.now();
  let firstToken,
    firstVisible,
    lastToken,
    usage,
    finishReason,
    content = '';
  try {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(120000),
      headers: { Authorization: `Bearer ${config.aiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } })
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP_${response.status}`);
    }
    const decoder = new TextDecoder();
    let buffer = '';
    const consume = line => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return;
      const chunk = JSON.parse(data);
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (delta?.content || delta?.reasoning_content || delta?.reasoning) {
        const now = performance.now();
        firstToken ??= now;
        lastToken = now;
        if (delta.content) {
          firstVisible ??= now;
          content += delta.content;
        }
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    };
    for await (const bytes of response.body) {
      buffer += decoder.decode(bytes, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        consume(buffer.slice(0, newline).trim());
        buffer = buffer.slice(newline + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer.trim());
    const elapsedMs = performance.now() - start;
    let validDecisions = false;
    try {
      const entries = JSON.parse(content).decisions;
      validDecisions =
        finishReason === 'stop' &&
        entries?.length === fixtures.length &&
        fixtures.every(
          (_, i) =>
            entries.filter(
              d => d.id === `email_${i + 1}` && ['keep', 'read', 'archive', 'both'].includes(d.decision?.action)
            ).length === 1
        );
    } catch {}
    const completion = usage?.completion_tokens;
    return {
      model,
      round,
      requestedReasoningEffort,
      elapsedMs: rounded(elapsedMs),
      ttftMs: firstToken ? rounded(firstToken - start) : null,
      timeToVisibleMs: firstVisible ? rounded(firstVisible - start) : null,
      promptTokens: usage?.prompt_tokens ?? null,
      completionTokens: completion ?? null,
      reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? null,
      cachedPromptTokens: usage?.prompt_tokens_details?.cached_tokens ?? null,
      generationTPS:
        completion && lastToken > firstToken ? rounded((completion * 1000) / (lastToken - firstToken)) : null,
      endToEndTPS: completion ? rounded((completion * 1000) / elapsedMs) : null,
      finishReason,
      validDecisions
    };
  } catch (error) {
    return {
      model,
      round,
      elapsedMs: rounded(performance.now() - start),
      error: /^HTTP_\d+$/.test(error.message) ? error.message : error.name,
      validDecisions: false
    };
  }
}
// Sequential within each model permits cache reuse; at most two calls in flight.
await Promise.all(
  models.map(async model => {
    for (let round = 1; round <= rounds; round++) {
      const result = await sample(model, round);
      results.push(result);
      console.log(JSON.stringify(result));
    }
  })
);
const median = numbers => {
  const n = numbers.filter(Number.isFinite).sort((a, b) => a - b);
  return n.length ? rounded(n.length % 2 ? n[(n.length - 1) / 2] : (n[n.length / 2 - 1] + n[n.length / 2]) / 2) : null;
};
const report = {
  measuredAt: new Date().toISOString(),
  workload: '10 synthetic emails, repeated identical prompts, no Gmail access',
  notes:
    'Client-observed streaming TPS includes provider-reported completion tokens (including reasoning when reported). Approximate generation TPS excludes first-token wait. Not an accuracy or concurrency-capacity benchmark. First request is not guaranteed cold; cache hits are best-effort. Super uses medium; Ultra uses provider default.',
  summary: models.map(model => {
    const rows = results.filter(r => r.model === model);
    return {
      model,
      successful: rows.filter(r => r.validDecisions).length,
      requests: rows.length,
      medianGenerationTPS: median(rows.map(r => r.generationTPS)),
      medianEndToEndTPS: median(rows.map(r => r.endToEndTPS)),
      medianTTFTMs: median(rows.map(r => r.ttftMs)),
      medianElapsedMs: median(rows.map(r => r.elapsedMs)),
      promptTokens: rows.reduce((n, r) => n + (r.promptTokens || 0), 0),
      cachedPromptTokens: rows.reduce((n, r) => n + (r.cachedPromptTokens || 0), 0)
    };
  }),
  results
};
await mkdir('data', { recursive: true });
const path = `data/nebius-benchmark-${report.measuredAt.replace(/[:.]/g, '-')}.json`;
await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ report: path, summary: report.summary }));
if (results.some(r => !r.validDecisions)) process.exitCode = 1;
