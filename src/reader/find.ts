import { computed, ref } from "vue";
import type { VirtualReader } from "./virtual-reader";
import { findText, type TextMatch } from "./virtual-index";

type HighlightSet = { set(name: string, value: unknown): void; delete(name: string): void };
function highlightAPI() {
  return {
    registry: (globalThis.CSS as typeof CSS & { highlights?: HighlightSet }).highlights,
    Highlight: (globalThis as typeof globalThis & { Highlight?: new (...ranges: Range[]) => unknown }).Highlight,
  };
}

/** Store numeric text offsets for the whole document, Ranges only for mounted matches. */
export function useFind(reader: () => VirtualReader | undefined) {
  const query = ref("");
  const visible = ref(false);
  const total = ref(0), active = ref(0), limited = ref(false);
  const count = computed(() => total.value ? `${active.value + 1} / ${total.value}${limited.value ? "+" : ""}` : "0 / 0");
  let matches: TextMatch[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fallbackSelection = false;
  function clearHighlights() {
    const { registry } = highlightAPI();
    registry?.delete("reader-find"); registry?.delete("reader-current");
    if (fallbackSelection) window.getSelection()?.removeAllRanges();
    fallbackSelection = false;
  }
  function clear() {
    clearTimeout(timer); timer = undefined;
    clearHighlights(); matches = [];
    total.value = 0; active.value = 0; limited.value = false;
  }
  function refresh() {
    clearHighlights();
    const view = reader();
    if (!view || !matches.length) return;
    const { registry, Highlight } = highlightAPI();
    const current = view.range(matches[active.value]);
    if (registry && Highlight) {
      const ranges = matches.map((match) => view.range(match)).filter((range): range is Range => !!range);
      if (ranges.length) registry.set("reader-find", new Highlight(...ranges));
      if (current) registry.set("reader-current", new Highlight(current));
    } else if (current) {
      const selection = window.getSelection();
      selection?.removeAllRanges(); selection?.addRange(current); fallbackSelection = true;
    }
  }
  function focusMatch() {
    const match = matches[active.value];
    if (match) reader()?.focusMatch(match);
    refresh();
  }
  function search() {
    clear();
    const view = reader();
    if (!view || !query.value) return;
    const result = findText(view.model.blocks, query.value);
    matches = result.matches; limited.value = result.limited; total.value = matches.length;
    focusMatch();
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(search, 150); }
  function move(delta: number) {
    if (timer !== undefined) search();
    if (!matches.length) return;
    active.value = (active.value + delta + matches.length) % matches.length;
    focusMatch();
  }
  function close() { visible.value = false; clear(); }
  function reset() { query.value = ""; clear(); }
  return { query, visible, count, limited, schedule, search, move, close, reset, clear, refresh };
}
