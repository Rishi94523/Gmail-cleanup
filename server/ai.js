// One transport for discovery, autonomous decisions, and advanced classification.
// Provider changes are explicit: never send mail to a fallback provider on failure.
export function aiConfig(env = process.env) {
  const aiProvider = (env.AI_PROVIDER || 'openrouter').trim().toLowerCase();
  if (!['openrouter', 'nebius'].includes(aiProvider)) throw new Error('AI_PROVIDER must be openrouter or nebius.');
  return {
    aiProvider,
    aiKey: (aiProvider === 'nebius' ? env.NEBIUS_API_KEY : (env.OPENROUTER_API_KEY || env.AI_API_KEY))?.trim() || '',
    aiModel: (aiProvider === 'nebius' ? env.NEBIUS_MODEL : (env.OPENROUTER_MODEL || env.AI_MODEL))?.trim() || (aiProvider === 'nebius' ? 'nvidia/Nemotron-3.5-Super-VL' : 'google/gemini-2.5-flash')
  };
}
export function aiLabel(config) { return config.aiProvider === 'nebius' ? 'Nebius Token Factory' : 'OpenRouter'; }
export function missingAIKey(config) { return `Configure ${config.aiProvider === 'nebius' ? 'NEBIUS_API_KEY' : 'OPENROUTER_API_KEY (or AI_API_KEY)'} for ${aiLabel(config)} and restart the server.`; }
export async function chatJSON(config, messages, fetcher = fetch, tools = []) {
  const provider = config.aiProvider || 'openrouter';
  if (!['openrouter', 'nebius'].includes(provider)) throw new Error('Unsupported AI provider.');
  if (!config.aiKey) throw new Error(missingAIKey(config));
  const url = provider === 'nebius' ? 'https://api.tokenfactory.us-north1.nebius.com/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions';
  let response;
  try {
    response = await fetcher(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120000), headers: { Authorization: `Bearer ${config.aiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: config.aiModel, temperature: 0, max_tokens: 4096, ...(tools.length ? { tools, tool_choice: 'auto' } : { response_format: { type: 'json_object' } }), messages }) });
  } catch { throw new Error(`${aiLabel(config)} could not be reached or timed out. Remaining emails were left unchanged.`); }
  if (!response.ok) throw new Error(`${aiLabel(config)} request failed (${response.status}). Check the API key, model access, and quota.`);
  try {
    const result = await response.json(); const choice = result.choices?.[0];
    if (choice?.finish_reason === 'tool_calls') {
      const calls = choice.message?.tool_calls;
      if (!tools.some(t => t.function.name === 'ask_preference') || calls?.length !== 1 || calls[0].function?.name !== 'ask_preference') throw new Error('Unsupported tool call');
      return { requestPreference: JSON.parse(calls[0].function.arguments) };
    }
    if (choice?.finish_reason !== 'stop' || typeof choice.message?.content !== 'string') throw new Error('Incomplete response');
    const parsed = JSON.parse(choice.message.content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected JSON object');
    return parsed;
  } catch { throw new Error(`${aiLabel(config)} returned an incomplete or invalid JSON decision. Remaining emails were left unchanged.`); }
}
