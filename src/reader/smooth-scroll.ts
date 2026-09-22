/** Incremental animation: virtual height corrections remain owned by the renderer. */
export function createSmoothScroll(area: HTMLElement) {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let frame = 0, remaining = 0, last = 0;
  function cancel() {
    cancelAnimationFrame(frame); frame = 0; remaining = 0;
  }
  function tick(now: number) {
    frame = 0;
    const dt = Math.min(50, Math.max(1, now - last)); last = now;
    const step = Math.sign(remaining) * Math.min(Math.abs(remaining),
      Math.max(1, Math.abs(remaining) * (1 - Math.exp(-dt / 65))));
    const before = area.scrollTop;
    area.scrollTop += step;
    // Account for the browser's pixel rounding; opposite half-page keys must cancel exactly.
    const moved = area.scrollTop - before;
    remaining -= moved;
    if (Math.abs(remaining) < 0.5 || Math.abs(moved) < 0.01) {
      cancel(); return;
    }
    frame = requestAnimationFrame(tick);
  }
  function by(delta: number) {
    if (!Number.isFinite(delta)) return;
    if (reduced.matches) { cancel(); area.scrollTop += delta; return; }
    // Accumulate repeated keys/wheel input without repeatedly restarting the easing.
    remaining = Math.max(-area.scrollTop, Math.min(
      area.scrollHeight - area.clientHeight - area.scrollTop, remaining + delta
    ));
    if (!frame && remaining) { last = performance.now(); frame = requestAnimationFrame(tick); }
  }
  function wheel(event: WheelEvent) {
    if (event.defaultPrevented || !event.cancelable || event.ctrlKey || event.metaKey || event.shiftKey ||
        reduced.matches || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      cancel(); return;
    }
    let node = event.target instanceof Element ? event.target : null;
    while (node && node !== area) {
      if (node.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])') ||
          (node.scrollHeight > node.clientHeight && /auto|scroll/.test(getComputedStyle(node).overflowY))) {
        cancel(); return;
      }
      node = node.parentElement;
    }
    const unit = event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? area.clientHeight : 1;
    event.preventDefault(); by(event.deltaY * unit);
  }
  function key(event: KeyboardEvent) {
    if (!["d", "e"].includes(event.key) || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) cancel();
  }
  area.addEventListener("wheel", wheel, { passive: false });
  window.addEventListener("pointerdown", cancel, true);
  window.addEventListener("touchstart", cancel, { passive: true });
  window.addEventListener("keydown", key, true);
  window.addEventListener("blur", cancel);
  reduced.addEventListener("change", cancel);
  return {
    by, cancel,
    dispose() {
      cancel();
      area.removeEventListener("wheel", wheel);
      window.removeEventListener("pointerdown", cancel, true);
      window.removeEventListener("touchstart", cancel);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", cancel);
      reduced.removeEventListener("change", cancel);
    },
  };
}
