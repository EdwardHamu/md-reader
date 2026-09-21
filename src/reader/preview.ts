// Hover preview for footnote references and in-document anchor links.
// Clones a bounded snapshot of the target block into a floating card so
// readers can peek without losing their place. Clones are detached on
// hide; nothing from the live document is retained.
import { shallowRef } from "vue";
import { findAnchor } from "./paths";

const SHOW_DELAY = 350;
const HIDE_DELAY = 250;
const MAX_NODES = 300;

export function useHoverPreview(
  root: () => HTMLElement | null,
  resolve?: (hash: string) => HTMLElement | null
) {
  const visible = shallowRef(false);
  const card = shallowRef<HTMLElement | null>(null);
  const position = shallowRef({ x: 0, y: 0 });
  const content = shallowRef<HTMLElement | null>(null);
  let showTimer = 0;
  let hideTimer = 0;

  function clonePreview(target: HTMLElement): HTMLElement | null {
    // Headings preview the section start: heading plus following siblings.
    const parts: HTMLElement[] = [];
    if (/^H[1-6]$/.test(target.tagName)) {
      let node: Element | null = target;
      while (node && parts.length < 4) {
        if (node instanceof HTMLElement) parts.push(node);
        node = node.nextElementSibling;
        if (node && /^H[1-6]$/.test(node.tagName)) break;
      }
    } else {
      parts.push(target);
    }
    const holder = document.createElement("div");
    let nodes = 0;
    for (const part of parts) {
      const clone = part.cloneNode(true) as HTMLElement;
      const walker = document.createTreeWalker(clone, NodeFilter.SHOW_ELEMENT);
      while (walker.nextNode()) {
        if (++nodes > MAX_NODES) return holder; // Bounded snapshot.
      }
      clone.removeAttribute("id"); // Never duplicate anchor ids.
      for (const nested of clone.querySelectorAll("[id]"))
        nested.removeAttribute("id");
      holder.append(clone);
    }
    return holder;
  }

  function show(anchor: HTMLAnchorElement, hash: string) {
    const body = root();
    if (!body) return;
    const target = resolve ? resolve(hash) : findAnchor(body, hash);
    if (!target) return;
    const snapshot = clonePreview(target);
    if (!snapshot || !snapshot.childNodes.length) return;
    const rect = anchor.getBoundingClientRect();
    content.value = snapshot;
    position.value = { x: rect.left, y: rect.bottom + 8 };
    visible.value = true;
  }

  function schedule(anchor: HTMLAnchorElement, hash: string) {
    cancel();
    showTimer = window.setTimeout(() => show(anchor, hash), SHOW_DELAY);
  }

  function scheduleHide() {
    window.clearTimeout(showTimer);
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(hide, HIDE_DELAY);
  }

  function holdOpen() {
    window.clearTimeout(hideTimer);
  }

  function hide() {
    cancel(); // A click/scroll must also cancel a not-yet-visible preview.
    visible.value = false;
    content.value = null;
  }

  function cancel() {
    window.clearTimeout(showTimer);
    window.clearTimeout(hideTimer);
  }

  function dispose() {
    cancel();
    hide();
  }

  return {
    visible,
    card,
    position,
    content,
    schedule,
    scheduleHide,
    holdOpen,
    hide,
    dispose,
  };
}
