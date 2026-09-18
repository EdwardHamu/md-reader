/**
 * 阅读区滚动侦测：根据当前滚动位置计算目录（TOC）应高亮的标题 id。
 * onScroll 由 App.vue 的滚动事件驱动（rAF 节流）；jumpTo 供目录点击跳转。
 */

import { ref, Ref } from "vue";

export function useScrollSpy(
  containerRef: Ref<HTMLElement | null>,
  bodyRef: Ref<HTMLElement | null>
) {
  // 当前高亮的标题 id（与 TOC 面板联动）
  const activeId = ref<string>("");
  let raf = 0;

  /**
   * 计算当前标题：从上往下找最后一个 top 距容器顶 < 80px 的标题。
   * rAF 节流避免滚动事件高频触发全量 getBoundingClientRect。
   */
  function onScroll() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const container = containerRef.value;
      const body = bodyRef.value;
      if (!container || !body) return;
      const containerTop = container.getBoundingClientRect().top;
      const hs = body.querySelectorAll<HTMLElement>(
        "h1, h2, h3, h4, h5, h6"
      );
      let current = "";
      for (const h of Array.from(hs)) {
        const rect = h.getBoundingClientRect();
        if (rect.top - containerTop < 80) {
          current = h.getAttribute("id") || "";
        } else {
          break;
        }
      }
      activeId.value = current;
    });
  }

  /** 平滑滚动到指定 id 的标题（上留 8px 视觉缓冲）。 */
  function jumpTo(id: string) {
    const body = bodyRef.value;
    const container = containerRef.value;
    if (!body || !container) return;
    // CSS.escape 处理含特殊字符的 id（中文标题等）
    const target = body.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    if (target) {
      const offset =
        target.getBoundingClientRect().top -
        container.getBoundingClientRect().top +
        container.scrollTop -
        8;
      container.scrollTo({ top: offset, behavior: "smooth" });
    }
  }

  return { activeId, onScroll, jumpTo };
}
