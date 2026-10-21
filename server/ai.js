// One transport for discovery, autonomous decisions, and advanced classification.
// Provider changes are explicit: never send mail to a fallback provider on failure.
import { failure } from './failures.js';
export function aiConfig(env = process.env) {
  if (env.AI_PROVIDER && env.AI_PROVIDER.trim().toLowerCase() !== 'nebius')
    throw new Error('This hackathon edition supports Nebius Token Factory only.');
  return {
    aiProvider: 'nebius',
    aiKey: env.NEBIUS_API_KEY?.trim() || '',
    aiModel: env.NEBIUS_MODEL?.trim() || 'nvidia/Nemotron-3.5-Super-VL'
  };
}
export function aiLabel() {
  return 'Nebius Token Factory';
}
export function missingAIKey() {
  return 'Configure NEBIUS_API_KEY and restart the server.';
}
export async function chatJSON(config, messages, fetcher = fetch, tools = []) {
  const provider = config.aiProvider || 'nebius';
  if (provider !== 'nebius') throw new Error('Unsupported AI provider.');
  if (!config.aiKey) throw new Error(missingAIKey(config));
  const region = /^nvidia\/Nemotron-3-Ultra-/i.test(config.aiModel) ? 'us-central1' : 'us-north1';
  const url = `https://api.tokenfactory.${region}.nebius.com/v1/chat/completions`;
  const started = Date.now();
  let response;
  try {
    // Explicitly override the provider's smaller default; retain default reasoning.
    response = await fetcher(url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(120000),
      headers: { Authorization: `Bearer ${config.aiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.aiModel,
        max_tokens: 50000,
        temperature: 0,
        ...(tools.length ? { tools, tool_choice: 'auto' } : { response_format: { type: 'json_object' } }),
        messages
      })
    });
  } catch {
    console.warn(
      JSON.stringify({ event: 'ai_request_failed', provider, elapsedMs: Date.now() - started, code: 'AI_UNAVAILABLE' })
    );
    throw failure(
      'AI_UNAVAILABLE',
      `${aiLabel(config)} could not be reached or timed out. Remaining emails were left unchanged.`
    );
  }
  if (!response.ok) {
    console.warn(
      JSON.stringify({ event: 'ai_request_failed', provider, elapsedMs: Date.now() - started, status: response.status })
    );
    throw failure(
      `AI_HTTP_${response.status}`,
      `${aiLabel(config)} request failed (${response.status}). Check the API key, model access, and quota.`
    );
  }
  try {
    const result = await response.json();
    const choice = result.choices?.[0];
    // Operational metadata only: never log prompts, response content, mail or keys.
    const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : null);
    console.info(
      JSON.stringify({
        event: 'ai_request_complete',
        provider,
        model: config.aiModel,
        elapsedMs: Date.now() - started,
        promptTokens: count(result.usage?.prompt_tokens),
        completionTokens: count(result.usage?.completion_tokens),
        reasoningTokens: count(result.usage?.completion_tokens_details?.reasoning_tokens),
        cachedPromptTokens: count(result.usage?.prompt_tokens_details?.cached_tokens),
        truncated: choice?.finish_reason === 'length'
      })
    );
    if (choice?.finish_reason === 'length') {
      console.warn(
        JSON.stringify({
          event: 'ai_truncated',
          provider,
          model: config.aiModel,
          completionTokens: result.usage?.completion_tokens
        })
      );
      throw failure(
        'AI_TRUNCATED',
        `${aiLabel(config)} reached its response limit before returning a complete decision. Cleanup stopped; remaining emails were left unchanged.`
      );
    }
    if (choice?.finish_reason === 'tool_calls') {
      const calls = choice.message?.tool_calls;
      if (
        !tools.some(t => t.function.name === 'ask_preference') ||
        calls?.length !== 1 ||
        calls[0].function?.name !== 'ask_preference'
      )
        throw new Error('Unsupported tool call');
      return { requestPreference: JSON.parse(calls[0].function.arguments) };
    }
    if (choice?.finish_reason !== 'stop' || typeof choice.message?.content !== 'string')
      throw new Error('Incomplete response');
    const parsed = JSON.parse(choice.message.content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected JSON object');
    return parsed;
  } catch (error) {
    if (error.publicCode) throw error;
    throw failure(
      'AI_INVALID_OUTPUT',
      `${aiLabel(config)} returned an incomplete or invalid JSON decision. Remaining emails were left unchanged.`
    );
  }
}
