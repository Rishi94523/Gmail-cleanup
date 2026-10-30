// Only fully validated batch results are yielded. A slow/failing sibling cannot
// block successful results; outstanding AI calls are drained before releasing the lock.
export async function* readyBatches(batches, classify) {
  const jobs = batches.map((batch, index) =>
    Promise.resolve()
      .then(() => classify(batch))
      .then(
        result => ({ index, batch, result }),
        error => ({ index, error })
      )
  );
  const pending = new Map(jobs.map((job, index) => [index, job]));
  let failure;
  try {
    while (pending.size) {
      const item = await Promise.race(pending.values());
      pending.delete(item.index);
      if (item.error) {
        failure ||= item.error;
        continue;
      }
      yield item;
    }
    if (failure) throw failure;
  } finally {
    await Promise.all(jobs);
  }
}
