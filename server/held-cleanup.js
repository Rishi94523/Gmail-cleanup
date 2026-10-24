import { runAgent } from './agent.js';
import { answeredHeldIds } from './learning.js';
import { publicFailure } from './failures.js';

// Runs inside the answer request and its existing account lock. Awaiting the
// work keeps Cloud Run request CPU available; this is not a detached timer.
export async function cleanAnsweredHolds(service, id, answer, guard, runner = runAgent) {
  const cleanup = { status: 'not_needed', inspected: 0, changed: 0, kept: 0, waiting: 0 };
  if (answer.status !== 'saved' || !answer.answeredQuestionIds?.length) return { ...answer, cleanup };
  try {
    const targets = await answeredHeldIds(service, id, answer.answeredQuestionIds);
    for (let offset = 0; offset < targets.length; offset += 100) {
      await guard();
      const result = await runner(service, id, guard, undefined, 'held', undefined, undefined, {
        questionIds: answer.answeredQuestionIds,
        messageIds: targets.slice(offset, offset + 100)
      });
      for (const key of ['inspected', 'changed', 'kept', 'waiting']) cleanup[key] += result[key] || 0;
      cleanup.status = 'completed';
    }
  } catch (error) {
    // The answer was already committed. Do not tell the client to submit it
    // again or automatically replay any uncertain Gmail mutation.
    cleanup.status = 'failed';
    cleanup.message = publicFailure(error).message;
  }
  return { ...answer, cleanup };
}
