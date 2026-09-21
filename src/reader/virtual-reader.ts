import { HeightIndex, type TextMatch } from "./virtual-index";
import type { VirtualDocument } from "./virtual-document";
import { findAnchor } from "./paths";

export interface ReadingAnchor { block: number; offset: number }

/** Owns only the mounted window, with no detached-node cache. */
export function createVirtualReader(
  root: HTMLElement,
  area: HTMLElement,
  model: VirtualDocument,
  changed: () => void
) {
  const virtual = model.blocks.length > 80;
  const top = document.createElement("div");
  const content = document.createElement("div");
  const bottom = document.createElement("div");
  top.className = bottom.className = "virtual-spacer";
  top.setAttribute("aria-hidden", "true"); bottom.setAttribute("aria-hidden", "true");
  content.className = "virtual-window";
  root.replaceChildren(top, content, bottom);
  root.dataset.virtual = String(virtual);
  root.dataset.blocks = String(model.blocks.length);
  const mounted = new Map<number, HTMLElement>();
  const horizontal = new Map<number, number>();
  let frame = 0, disposed = false, rendering = false;
  let signature = "";
  let index = new HeightIndex([]);
  const observer = new ResizeObserver(schedule);
  const layoutObserver = new ResizeObserver(() => {
    if (layoutSignature() !== signature) invalidate();
  });
  function layoutSignature() {
    const style = getComputedStyle(root);
    return `${root.clientWidth}:${style.fontSize}:${style.fontFamily}:${style.lineHeight}`;
  }
  function estimates() {
    const style = getComputedStyle(root);
    const font = Number.parseFloat(style.fontSize) || 17;
    const width = Math.max(80, root.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight));
    const columns = Math.max(8, width / (font * 0.8));
    return model.blocks.map((block) => {
      const lines = block.text.split("\n").length;
      if (block.kind === "code") return lines * font * 1.6 * 0.88 + 64;
      if (block.kind === "heading") return Math.ceil(block.text.length / (columns / 1.5)) * font * 2 + font * 2;
      return Math.max(1, Math.ceil(block.text.length / columns), lines - 1) * font * 1.85 + font * 2;
    });
  }
  function origin() {
    return top.getBoundingClientRect().top - area.getBoundingClientRect().top - area.clientTop + area.scrollTop;
  }
  function capture(): ReadingAnchor {
    const position = Math.max(0, area.scrollTop - origin());
    const block = index.at(position);
    return { block, offset: position - index.prefix(block) };
  }
  function spacers(start: number, end: number) {
    top.style.height = `${index.prefix(start)}px`;
    bottom.style.height = `${Math.max(0, index.total - index.prefix(end))}px`;
    root.dataset.mounted = String(mounted.size);
  }
  function render(destination?: number) {
    if (disposed || rendering) return;
    rendering = true;
    try {
      // At most three settling passes; subsequent image/font measurements run in rAF.
      for (let pass = 0; pass < 3; pass++) {
        const relative = destination === undefined ? Math.max(0, area.scrollTop - origin()) : index.prefix(destination);
        const scrollBefore = destination === undefined ? area.scrollTop : origin() + relative;
        const anchor = destination === undefined ? capture() : { block: destination, offset: 0 };
        const previous = index.prefix(anchor.block);
        const range = virtual
          ? index.window(relative, area.clientHeight, Math.max(400, area.clientHeight))
          : { start: 0, end: model.blocks.length };
        // A hard guard complements the pixel overscan for adversarial near-empty markup.
        if (range.end - range.start > 256) {
          range.start = Math.max(range.start, index.at(relative) - 64);
          range.end = Math.min(model.blocks.length, range.start + 256);
        }
        for (const [key, node] of mounted) {
          if (key < range.start || key >= range.end) {
            observer.unobserve(node); node.remove(); mounted.delete(key);
          }
        }
        let cursor = content.firstChild;
        for (let key = range.start; key < range.end; key++) {
          let node = mounted.get(key);
          if (!node) {
            node = document.createElement("div");
            node.className = "virtual-block";
            node.dataset.block = String(key);
            node.dataset.kind = model.blocks[key].kind;
            // Only HTML serialized from DOMPurify's sanitized fragment reaches this sink.
            node.innerHTML = model.blocks[key].html;
            mounted.set(key, node); observer.observe(node);
          }
          if (node !== cursor) content.insertBefore(node, cursor);
          cursor = node.nextSibling;
          const table = node.querySelector<HTMLElement>(".table-wrap");
          if (table) table.scrollLeft = horizontal.get(model.blocks[key].group) || 0;
        }
        let measured = false;
        for (const [key, node] of mounted) {
          const height = Math.max(1, node.getBoundingClientRect().height);
          if (Math.abs(height - index.height(key)) > 0.5) {
            index.set(key, height); measured = true;
          }
        }
        spacers(range.start, range.end);
        // Disable browser anchoring in CSS: there must be only one correction owner.
        const delta = index.prefix(anchor.block) - previous;
        // Updating the bottom spacer can synchronously clamp scrollTop. Apply the
        // delta to the PRE-mutation offset, not to an already-clamped offset.
        // Removing old window nodes can also clamp the native scroller before
        // spacers are replaced, even when no measured height changed.
        area.scrollTop = scrollBefore + delta;
        if (!measured) break;
      }
    } finally { rendering = false; }
    changed();
  }
  function schedule() {
    if (!disposed && !frame) frame = requestAnimationFrame(() => { frame = 0; render(); });
  }
  function invalidate() {
    if (disposed) return;
    const anchor = capture();
    signature = layoutSignature();
    index = new HeightIndex(estimates());
    const start = mounted.size ? Math.min(...mounted.keys()) : 0;
    const end = mounted.size ? Math.max(...mounted.keys()) + 1 : 0;
    spacers(start, end);
    area.scrollTop = origin() + index.prefix(anchor.block) + anchor.offset;
    render();
  }
  function ensure(block: number) {
    if (disposed || !model.blocks[block]) return null;
    if (!mounted.has(block)) {
      // Measure a destination-centered window BEFORE setting the final scroll
      // offset. A short last block can otherwise be clamped out of an estimated
      // window when preceding tall blocks shrink during measurement.
      render(block);
    }
    return mounted.get(block) || null;
  }
  function restore(anchor: ReadingAnchor) {
    const block = Math.min(Math.max(0, anchor.block), model.blocks.length - 1);
    if (block < 0) return;
    ensure(block);
    area.scrollTop = origin() + index.prefix(block) + Math.min(anchor.offset, index.height(block) - 1);
    render();
  }
  function anchorIndex(hash: string) {
    if (model.anchors.has(hash)) return model.anchors.get(hash);
    try { return model.anchors.get(decodeURIComponent(hash)); } catch { return undefined; }
  }
  function jump(hash: string) {
    const block = anchorIndex(hash);
    if (block === undefined) return false;
    const host = ensure(block);
    if (!host) return false;
    const target = findAnchor(host, hash);
    if (!target) return false;
    area.scrollTop += target.getBoundingClientRect().top - area.getBoundingClientRect().top - area.clientTop - 28;
    render();
    // No smooth scroll across estimated heights; it fights measurement correction.
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
      target.classList.remove("anchor-flash");
      void target.offsetWidth;
      target.classList.add("anchor-flash");
    }
    return true;
  }
  function textPoint(block: number, at: number) {
    const host = mounted.get(block);
    if (!host) return null;
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const length = node.textContent?.length || 0;
      if (at <= length) return { node, offset: at };
      at -= length;
    }
    return null;
  }
  function range(match: TextMatch) {
    const start = textPoint(match.block, match.start);
    const end = textPoint(match.endBlock ?? match.block, match.end ?? match.start + match.length);
    if (!start || !end) return null;
    const result = document.createRange();
    result.setStart(start.node, start.offset); result.setEnd(end.node, end.offset);
    return result;
  }
  function focusMatch(match: TextMatch) {
    ensure(match.block);
    const target = range({ block: match.block, start: match.start,
      length: Math.min(match.length, model.blocks[match.block].text.length - match.start) });
    if (!target) return;
    const rect = target.getBoundingClientRect(), view = area.getBoundingClientRect();
    if (rect.top < view.top || rect.bottom > view.bottom) {
      area.scrollTop += rect.top - view.top - area.clientHeight / 2;
      render();
    }

  }
  function activeHeading() {
    const relative = area.scrollTop - origin() + 48;
    let active = "";
    // Binary search indexed headings, not thousands of live heading elements.
    let left = 0, right = model.headings.length - 1;
    while (left <= right) {
      const mid = (left + right) >> 1;
      const heading = model.headings[mid];
      const block = model.anchors.get(heading.id) || 0;
      const live = mounted.get(block);
      const node = live && findAnchor(live, heading.id);
      const position = node
        ? node.getBoundingClientRect().top - area.getBoundingClientRect().top + area.scrollTop - origin()
        : index.prefix(block);
      if (position <= relative) { active = heading.id; left = mid + 1; }
      else right = mid - 1;
    }
    return active || model.headings[0]?.id || "";
  }
  function preview(hash: string) {
    const block = anchorIndex(hash);
    if (block === undefined) return null;
    const holder = document.createElement("div");
    // A bounded transient snapshot, never mount an offscreen block into the main reader.
    for (let i = block; i < Math.min(block + 4, model.blocks.length); i++) {
      const shell = document.createElement("div"); shell.innerHTML = model.blocks[i].html;
      holder.append(...shell.childNodes);
    }
    return findAnchor(holder, hash);
  }
  function code(group: number) {
    return (model.codes.get(group) || []).map((slice) => model.blocks[slice.block].text.slice(slice.start, slice.start + slice.length)).join("");
  }
  function syncHorizontal(event: Event) {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.classList.contains("table-wrap")) return;
    const key = Number(target.closest<HTMLElement>("[data-block]")?.dataset.block);
    if (!model.blocks[key]) return;
    const group = model.blocks[key].group;
    if (horizontal.get(group) === target.scrollLeft) return;
    horizontal.set(group, target.scrollLeft);
    for (const [key, node] of mounted) {
      if (model.blocks[key].group !== group) continue;
      const table = node.querySelector<HTMLElement>(".table-wrap");
      if (table && table !== target) table.scrollLeft = target.scrollLeft;
    }
  }
  root.addEventListener("scroll", syncHorizontal, true);
  signature = layoutSignature();
  index = new HeightIndex(estimates());
  area.addEventListener("scroll", schedule, { passive: true });
  layoutObserver.observe(root);
  document.fonts.addEventListener("loadingdone", invalidate);
  render();
  return {
    model, virtual, range, focusMatch, jump, restore, capture, activeHeading, preview, code,
    refresh: render, invalidate,
    dispose() {
      disposed = true; cancelAnimationFrame(frame);
      observer.disconnect(); layoutObserver.disconnect();
      area.removeEventListener("scroll", schedule);
      document.fonts.removeEventListener("loadingdone", invalidate);
      root.removeEventListener("scroll", syncHorizontal, true);
      mounted.clear(); horizontal.clear(); root.replaceChildren();
      delete root.dataset.virtual; delete root.dataset.blocks; delete root.dataset.mounted;
    },
  };
}
export type VirtualReader = ReturnType<typeof createVirtualReader>;
