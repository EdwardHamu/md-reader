import { computed, ref, type Ref } from "vue";

const LIMIT = 1000;
type HighlightSet = {
  set(name: string, value: unknown): void;
  delete(name: string): void;
};
function highlightAPI() {
  return {
    registry: (globalThis.CSS as typeof CSS & { highlights?: HighlightSet })
      .highlights,
    Highlight: (
      globalThis as typeof globalThis & {
        Highlight?: new (...ranges: Range[]) => unknown;
      }
    ).Highlight,
  };
}

/** DOM Ranges only; never mutate prose/code text nodes or deep-proxy them through Vue. */
export function useFind(root: Ref<HTMLElement | null>) {
  const query = ref("");
  const visible = ref(false);
  const total = ref(0);
  const active = ref(0);
  const limited = ref(false);
  const count = computed(() =>
    total.value
      ? `${active.value + 1} / ${total.value}${limited.value ? "+" : ""}`
      : "0 / 0"
  );
  let ranges: Range[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fallbackSelection = false;
  function clear() {
    clearTimeout(timer);
    timer = undefined;
    const { registry } = highlightAPI();
    registry?.delete("reader-find");
    registry?.delete("reader-current");
    if (fallbackSelection) window.getSelection()?.removeAllRanges();
    fallbackSelection = false;
    ranges = [];
    total.value = 0;
    active.value = 0;
    limited.value = false;
  }
  function focusMatch() {
    const range = ranges[active.value];
    if (!range) return;
    const { registry, Highlight } = highlightAPI();
    if (registry && Highlight)
      registry.set("reader-current", new Highlight(range));
    else {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      fallbackSelection = true;
    }
    const rect = range.getBoundingClientRect();
    const scroll = root.value?.parentElement;
    if (
      scroll &&
      (rect.top < scroll.getBoundingClientRect().top ||
        rect.bottom > scroll.getBoundingClientRect().bottom)
    ) {
      scroll.scrollTop +=
        rect.top - scroll.getBoundingClientRect().top - scroll.clientHeight / 2;
    }
  }
  function search() {
    clear();
    const body = root.value;
    if (!body || !query.value) return;
    // A literal Unicode regexp preserves original offsets (lowercasing can change string length).
    const expression = new RegExp(
      query.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "giu"
    );
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.parentElement?.closest("script,style")
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      },
    });
    let node: Node | null;
    outer: while ((node = walker.nextNode())) {
      expression.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = expression.exec(node.textContent || ""))) {
        if (ranges.length === LIMIT) {
          limited.value = true;
          break outer;
        }
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        ranges.push(range);
      }
    }
    total.value = ranges.length;
    const { registry, Highlight } = highlightAPI();
    if (registry && Highlight && ranges.length)
      registry.set("reader-find", new Highlight(...ranges));
    focusMatch();
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(search, 150);
  }
  function move(delta: number) {
    if (timer !== undefined) search();
    if (!ranges.length) return;
    active.value = (active.value + delta + ranges.length) % ranges.length;
    focusMatch();
  }
  function close() {
    visible.value = false;
    clear();
  }
  function reset() {
    query.value = "";
    clear();
  }
  return {
    query,
    visible,
    count,
    limited,
    schedule,
    search,
    move,
    close,
    reset,
    clear,
  };
}
