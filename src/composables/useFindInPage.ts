/**
 * 页内查找（Ctrl+F）：对渲染后的 DOM 做纯前端文本匹配。
 * 实现方式是 TreeWalker 收集文本节点，把命中片段用 span 包裹加高亮；
 * 不依赖 window.find（WebView 不可用/不可控）。
 *
 * 注意：collectTextNodes 里跳过了 script/style/公式/Mermaid/已有高亮，
 * 以后新增带原始文本的渲染组件必须把它的类名加进那个 closest 选择器，
 * 否则查找会错误地命中源码文本。
 */

import { ref, computed, Ref } from "vue";

/** 高亮 span 的类名；HL_ACTIVE 标记当前跳转目标。 */
const HL = "find-highlight";
const HL_ACTIVE = "find-highlight-active";

export function useFindInPage(bodyRef: Ref<HTMLElement | null>) {
  const visible = ref(false);
  const query = ref("");
  const caseSensitive = ref(false);
  /** 全部命中高亮 span，按文档顺序排列。 */
  const matches = ref<HTMLElement[]>([]);
  const activeIndex = ref(0);
  const total = computed(() => matches.value.length);

  /** 撤销高亮：把 span 的子节点搬回原父节点再移除 span，最后 normalize 合并被拆散的文本节点。 */
  function clearHighlights() {
    const body = bodyRef.value;
    if (!body) return;
    body.querySelectorAll("." + HL).forEach((el) => {
      const parent = el.parentNode;
      if (!parent) return;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
    });
    body.normalize();
    matches.value = [];
    activeIndex.value = 0;
  }

  /** 收集可搜索的文本节点，跳过不可搜索的渲染组件（见文件头说明）。 */
  function collectTextNodes(): Text[] {
    const body = bodyRef.value;
    if (!body) return [];
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        const parent = (node as Text).parentElement;
        if (
          parent &&
          parent.closest("script, style, .math-inline, .math-block, .mermaid-block, ." + HL)
        )
          return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n: Node | null;
    while ((n = walker.nextNode())) nodes.push(n as Text);
    return nodes;
  }

  /** 用 Range.surroundContents 把 [start, end) 文本包进高亮 span。 */
  function wrapRange(node: Text, start: number, end: number): HTMLElement {
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const span = document.createElement("span");
    span.className = HL;
    range.surroundContents(span);
    return span;
  }

  /**
   * 执行搜索：逐节点 indexOf 找出全部命中偏移。
   * 同一节点内倒序包裹（positions 先按偏移降序排），这样前面的偏移
   * 不会因后面已经插入了 span 节点而失效；跨节点则最后统一按
   * 文档位置排序，保证 next/prev 的顺序和视觉顺序一致。
   */
  function search() {
    clearHighlights();
    const q = query.value;
    if (!q) return;
    const cs = caseSensitive.value;
    const nodes = collectTextNodes();
    const found: HTMLElement[] = [];
    for (const node of nodes) {
      const text = node.nodeValue || "";
      const hay = cs ? text : text.toLowerCase();
      const needle = cs ? q : q.toLowerCase();
      const positions: number[] = [];
      let from = 0;
      while (from <= hay.length - needle.length) {
        const idx = hay.indexOf(needle, from);
        if (idx === -1) break;
        positions.push(idx);
        from = idx + Math.max(needle.length, 1);
      }
      if (positions.length === 0) continue;
      positions.sort((a, b) => b - a);
      for (const pos of positions) {
        try {
          const span = wrapRange(node, pos, pos + needle.length);
          found.push(span);
        } catch {
          /* skip */
        }
      }
    }
    found.sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    );
    matches.value = found;
    if (found.length > 0) {
      activeIndex.value = 0;
      highlightActive();
    }
  }

  /** 切换 activeIndex 对应 span 的高亮态并滚动到可视中央。 */
  function highlightActive() {
    matches.value.forEach((el, i) => {
      el.classList.toggle(HL_ACTIVE, i === activeIndex.value);
    });
    const active = matches.value[activeIndex.value];
    if (active)
      active.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  /** 环形导航：越界回到开头/结尾。 */
  function next() {
    if (!total.value) return;
    activeIndex.value = (activeIndex.value + 1) % total.value;
    highlightActive();
  }

  function prev() {
    if (!total.value) return;
    activeIndex.value = (activeIndex.value - 1 + total.value) % total.value;
    highlightActive();
  }

  function open() {
    visible.value = true;
  }

  /** 关闭查找栏并清掉所有高亮。 */
  function close() {
    visible.value = false;
    clearHighlights();
  }

  /** 清空关键词（切换文档等场景）。 */
  function reset() {
    query.value = "";
    clearHighlights();
  }

  return {
    visible,
    query,
    caseSensitive,
    matches,
    activeIndex,
    total,
    open,
    close,
    search,
    next,
    prev,
    reset,
    clearHighlights,
  };
}
