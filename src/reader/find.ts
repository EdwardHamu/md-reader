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
  const regex = ref(false), searchError = ref(""), busy = ref(false);
  let worker: Worker | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  function stopWorker() {
    worker?.terminate(); worker = undefined;
    clearTimeout(deadline); deadline = undefined; busy.value = false;
  }
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
    stopWorker(); searchError.value = "";
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
    if (regex.value) {
      try {
        const task = new Worker(new URL("./regex.worker.ts", import.meta.url), { type: "module" });
        worker = task; busy.value = true;
        task.onmessage = (event: MessageEvent<{ matches?: TextMatch[]; limited?: boolean; error?: string }>) => {
          if (worker !== task) return;
          stopWorker();
          if (event.data.error) { searchError.value = event.data.error; return; }
          matches = event.data.matches || [];
          limited.value = !!event.data.limited; total.value = matches.length;
          focusMatch();
        };
        task.onerror = () => {
          if (worker !== task) return;
          stopWorker(); searchError.value = "正则搜索失败，请重试。";
        };
        deadline = setTimeout(() => {
          if (worker !== task) return;
          stopWorker(); searchError.value = "正则搜索超时，请简化表达式。";
        }, 1500);
        task.postMessage({ blocks: view.model.blocks.map(({ text, group }) => ({ text, group })), query: query.value });
      } catch { stopWorker(); searchError.value = "无法启动正则搜索。"; }
      return;
    }
    const result = findText(view.model.blocks, query.value);
    matches = result.matches; limited.value = result.limited; total.value = matches.length;
    focusMatch();
  }
  function schedule() { clear(); timer = setTimeout(search, 150); }
  function move(delta: number) {
    if (timer !== undefined) search();
    if (!matches.length) return;
    active.value = (active.value + delta + matches.length) % matches.length;
    focusMatch();
  }
  function close() { visible.value = false; clear(); }
  function reset() { query.value = ""; clear(); }
  return { query, visible, regex, searchError, busy, count, limited, schedule, search, move, close, reset, clear, refresh };
}
