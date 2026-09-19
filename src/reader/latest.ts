/** One in-flight read + one replaceable pending request; stale completions never render. */
export function createLatestLoader<T, R>(
  read: (input: T) => Promise<R>,
  commit: (result: R, input: T) => void,
  failed: (error: unknown) => void,
  settled: () => void
) {
  let revision = 0;
  let pending: { input: T; revision: number } | undefined;
  let running = false;
  let disposed = false;
  async function pump() {
    if (running) return;
    running = true;
    try {
      while (pending && !disposed) {
        const job = pending;
        pending = undefined;
        try {
          const result = await read(job.input);
          if (!disposed && job.revision === revision) commit(result, job.input);
        } catch (error) {
          if (!disposed && job.revision === revision) failed(error);
        }
      }
    } finally {
      running = false;
      if (!disposed) settled();
    }
  }
  return {
    request(input: T) {
      if (disposed) return;
      pending = { input, revision: ++revision };
      void pump();
    },
    cancel() {
      ++revision;
      pending = undefined;
    },
    dispose() {
      disposed = true;
      ++revision;
      pending = undefined;
    },
  };
}
