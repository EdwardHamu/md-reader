/** One-shot native reveal. Hidden WebViews may suspend rAF, so neither guard depends on it. */
export function createWindowReveal(reveal: () => Promise<unknown>) {
  let started = false;
  let scheduled = false;
  let sent = false;
  let disposed = false;
  let attempts = 0;
  let contentTimer: ReturnType<typeof setTimeout> | undefined;
  let paintTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let firstFrame = 0;
  let secondFrame = 0;
  function clear() {
    clearTimeout(contentTimer);
    clearTimeout(paintTimer);
    clearTimeout(retryTimer);
    cancelAnimationFrame(firstFrame);
    cancelAnimationFrame(secondFrame);
  }
  function send() {
    if (disposed || sent) return;
    sent = true;
    clear();
    // Resolve pending style/layout even when hidden rAF callbacks never run.
    document.querySelector(".reader-shell")?.getBoundingClientRect();
    attempts++;
    void reveal().catch(() => {
      if (!disposed && attempts < 3) {
        sent = false;
        retryTimer = setTimeout(send, 100);
      }
      // The independent Rust watchdog reveals the window if IPC remains unavailable.
    });
  }
  function ready() {
    if (disposed || scheduled || sent) return;
    scheduled = true;
    clearTimeout(contentTimer);
    firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(send);
    });
    paintTimer = setTimeout(send, 120);
  }
  return {
    start() {
      if (started || disposed) return;
      started = true;
      // At most 400ms for initial IPC/document work; then reveal the usable loading UI.
      contentTimer = setTimeout(ready, 400);
    },
    ready,
    dispose() {
      disposed = true;
      clear();
    },
  };
}
