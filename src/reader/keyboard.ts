export type ReadingCommand = "top" | "bottom" | "down" | "up" | "search";
export function createReadingKeys() {
  let pending = -Infinity;
  function reset() { pending = -Infinity; }
  function accept(key: string, repeat = false, now = performance.now()): ReadingCommand | undefined {
    if (key === "g") {
      if (repeat) return;
      if (now - pending <= 800) { reset(); return "top"; }
      pending = now; return;
    }
    reset();
    if (key === "G") return "bottom";
    if (key === "d") return "down";
    if (key === "e") return "up";
    if (key === "/") return "search";
  }
  return { accept, reset };
}
export function isEditingTarget(target: EventTarget | null) {
  return target instanceof Element && !!target.closest(
    'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]'
  );
}
