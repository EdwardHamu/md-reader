// Jump history for in-document navigation: browser-style back/forward.
// Entries store scroll offsets, not DOM references, so history survives
// re-renders and never retains detached nodes.
import { computed, shallowRef } from "vue";

export interface JumpEntry {
  path: string;
  scrollTop: number;
  anchor?: { block: number; offset: number };
}

const MAX_ENTRIES = 100;

export function useJumpHistory(
  capture: () => JumpEntry | null,
  restore: (entry: JumpEntry) => void
) {
  const backStack = shallowRef<JumpEntry[]>([]);
  const forwardStack = shallowRef<JumpEntry[]>([]);
  const canBack = computed(() => backStack.value.length > 0);
  const canForward = computed(() => forwardStack.value.length > 0);

  /** Record the position being left right before a jump lands. */
  function push() {
    const entry = capture();
    if (!entry) return;
    const next = [...backStack.value, entry];
    if (next.length > MAX_ENTRIES) next.shift();
    backStack.value = next;
    forwardStack.value = []; // A new jump truncates the forward branch.
  }

  function back() {
    const entry = backStack.value[backStack.value.length - 1];
    if (!entry) return;
    const here = capture();
    backStack.value = backStack.value.slice(0, -1);
    if (here) forwardStack.value = [...forwardStack.value, here];
    restore(entry);
  }

  function forward() {
    const entry = forwardStack.value[forwardStack.value.length - 1];
    if (!entry) return;
    const here = capture();
    forwardStack.value = forwardStack.value.slice(0, -1);
    if (here) backStack.value = [...backStack.value, here];
    restore(entry);
  }

  function clear() {
    backStack.value = [];
    forwardStack.value = [];
  }

  return { canBack, canForward, push, back, forward, clear };
}
