/**
 * 侧栏拖拽调宽：pointerdown 后跟踪 pointermove 计算增量，松手时把
 * 宽度存 localStorage（记忆用户偏好）。inverse 用于右侧栏（向左拖变宽）。
 */

import { ref, Ref } from "vue";

export function useResizable(
  storageKey: string,
  initial: number,
  options: { min?: number; max?: number; inverse?: boolean } = {}
) {
  const min = options.min ?? 160;
  const max = options.max ?? 500;
  const inverse = options.inverse ?? false;
  const width: Ref<number> = ref(
    parseInt(localStorage.getItem(storageKey) || String(initial), 10)
  );

  function startResize(evt: PointerEvent) {
    evt.preventDefault();
    const startX = evt.clientX;
    const startW = width.value;
    function onMove(e: PointerEvent) {
      // inverse：右栏的把手在左边缘，鼠标向左移动（负 dx）才是变宽
      const dx = inverse ? startX - e.clientX : e.clientX - startX;
      width.value = Math.max(min, Math.min(max, startW + dx));
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      localStorage.setItem(storageKey, String(width.value));
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return { width, startResize };
}
