import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
const context = new AsyncLocalStorage();
export const traceFields = () => {
  const c = context.getStore();
  return c
    ? {
        traceId: c.traceId,
        workflow: c.workflow,
        ...(c.parentTraceId ? { parentTraceId: c.parentTraceId } : {}),
        ...(c.runId ? { runId: c.runId } : {}),
        ...(c.batchId ? { batchId: c.batchId, pass: c.pass } : {})
      }
    : {};
};
export function setRunId(runId) {
  const c = context.getStore();
  if (c) c.runId = runId;
}
export function timingEvent(event, fields = {}) {
  if (process.env.PERFORMANCE_LOGGING === 'false') return;
  console.info(JSON.stringify({ event, ...traceFields(), ...fields }));
}
export async function timed(operation, fn, fields = {}) {
  const c = context.getStore();
  if (!c || process.env.PERFORMANCE_LOGGING === 'false') return fn();
  const spanId = randomUUID();
  const start = performance.now();
  timingEvent('operation_start', { operation, spanId, ...fields });
  let ok = false;
  let failureFields = {};
  try {
    const result = await fn();
    ok = true;
    return result;
  } catch (error) {
    failureFields = {
      ...(Number.isInteger(error.status) ? { status: error.status } : {}),
      ...(/^[A-Z0-9_]{5,32}$/.test(error.publicCode || error.code || '')
        ? { errorCode: error.publicCode || error.code }
        : {})
    };
    throw error;
  } finally {
    const elapsedMs = Math.round((performance.now() - start) * 100) / 100;
    const stat = (c.operations[operation] ||= { count: 0, totalMs: 0, maxMs: 0, failures: 0 });
    stat.count++;
    stat.totalMs += elapsedMs;
    stat.maxMs = Math.max(stat.maxMs, elapsedMs);
    if (!ok) stat.failures++;
    timingEvent('operation_complete', { operation, spanId, elapsedMs, ok, ...failureFields, ...fields });
  }
}
export function traced(workflow, fn) {
  const parentTraceId = context.getStore()?.traceId;
  return context.run({ traceId: randomUUID(), parentTraceId, workflow, operations: {} }, async () => {
    const start = performance.now();
    timingEvent('workflow_start');
    let ok = false;
    try {
      const value = await fn();
      ok = true;
      return value;
    } finally {
      timingEvent('workflow_complete', {
        ok,
        elapsedMs: Math.round(performance.now() - start),
        operations: context.getStore().operations
      });
    }
  });
}
// Never include SQL text or bound values: literals may contain personal data.
export function queryFields(sql) {
  return {
    statement: createHash('sha256').update(sql).digest('hex').slice(0, 16),
    verb:
      /^(SELECT|INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK|CREATE|ALTER|PRAGMA)\b/i
        .exec(sql.trim())?.[1]
        .toUpperCase() || 'OTHER'
  };
}

export function contextual(fields, fn) {
  const parent = context.getStore();
  return parent ? context.run({ ...parent, ...fields }, fn) : fn();
}

export function timedSync(operation, fn) {
  const c = context.getStore();
  if (!c || process.env.PERFORMANCE_LOGGING === 'false') return fn();
  const start = performance.now();
  let ok = false;
  try {
    const value = fn();
    ok = true;
    return value;
  } finally {
    const elapsedMs = Math.round((performance.now() - start) * 100) / 100;
    const stat = (c.operations[operation] ||= { count: 0, totalMs: 0, maxMs: 0, failures: 0 });
    stat.count++;
    stat.totalMs += elapsedMs;
    stat.maxMs = Math.max(stat.maxMs, elapsedMs);
    if (!ok) stat.failures++;
    timingEvent('operation_complete', { operation, elapsedMs, ok });
  }
}
