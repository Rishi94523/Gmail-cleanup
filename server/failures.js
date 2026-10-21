export function failure(code, message) {
  return Object.assign(new Error(message), { publicCode: code, publicMessage: message });
}
export function publicFailure(error) {
  if (error.publicCode?.startsWith('AI_'))
    return {
      code: error.publicCode,
      message: 'Your agent could not finish this step. Remaining emails were left unchanged. Please try again later.'
    };
  if (error.publicCode && error.publicMessage) return { code: error.publicCode, message: error.publicMessage };
  if (error.status === 401)
    return { code: 'GMAIL_AUTH', message: 'Your Gmail connection expired. Reconnect Gmail before continuing.' };
  return {
    code: 'AGENT_STOPPED',
    message:
      'Cleanup stopped before finishing. Check Activity for confirmed changes; remaining emails were left unchanged.'
  };
}
