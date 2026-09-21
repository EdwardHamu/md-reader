import { renderMarkdownChunks } from "./markdown";
import { sanitizeDocumentHtml, type Heading } from "./document";

export interface VirtualBlock {
  html: string;
  text: string;
  group: number;
  kind: "heading" | "code" | "prose";
}
export interface VirtualDocument {
  blocks: VirtualBlock[];
  headings: Heading[];
  anchors: Map<string, number>;
  codes: Map<number, { block: number; start: number; length: number }[]>;
}

const MAX_CHARS = 6000;
const MAX_NODES = 240;
const MAX_LINES = 80;

/** Split oversized sanitized trees while cloning ancestor shells, never source syntax.
 * This keeps inline markup, list/table structure and exactly-once text; only the first
 * shell retains an id. No detached document tree survives serialization.
 */
function* splitElement(root: HTMLElement): Generator<HTMLElement> {
  const sizes = new WeakMap<Node, { chars: number; nodes: number; lines: number }>();
  function weigh(node: Node): { chars: number; nodes: number; lines: number } {
    const size = { chars: node.nodeType === Node.TEXT_NODE ? (node.textContent?.length || 0) : 0, nodes: 1, lines: node.nodeType === Node.TEXT_NODE ? (node.textContent?.match(/\n/g)?.length || 0) : 0 };
    for (const child of node.childNodes) {
      const weight = weigh(child);
      size.chars += weight.chars;
      size.nodes += weight.nodes;
      size.lines += weight.lines;
    }
    sizes.set(node, size);
    return size;
  }
  const total = weigh(root);
  if (total.chars <= MAX_CHARS && total.nodes <= MAX_NODES && total.lines <= MAX_LINES) { yield root; return; }
  const orderedValues = new WeakMap<Node, number>();
  for (const list of [root, ...root.querySelectorAll("ol")]) {
    if (list.tagName !== "OL") continue;
    const step = list.hasAttribute("reversed") ? -1 : 1;
    let value = Number(list.getAttribute("start")) || (step < 0 ? list.children.length : 1);
    for (const item of list.children) {
      if (item.hasAttribute("value")) value = Number(item.getAttribute("value"));
      orderedValues.set(item, value); value += step;
    }
  }
  const seenIds = new Set<string>();
  const seenShells = new WeakSet<Node>();
  let holder = document.createElement("div");
  let shells = new Map<Node, HTMLElement>();
  let chars = 0, nodes = 0, lines = 0;
  function stripRepeatedIds(node: HTMLElement) {
    for (const element of [node, ...node.querySelectorAll<HTMLElement>("[id]")]) {
      if (!element.id) continue;
      if (seenIds.has(element.id)) element.removeAttribute("id");
      else seenIds.add(element.id);
    }
  }
  function parent(path: HTMLElement[]) {
    let target: HTMLElement = holder;
    for (const ancestor of path) {
      let shell = shells.get(ancestor);
      if (!shell) {
        shell = ancestor.cloneNode(false) as HTMLElement;
        stripRepeatedIds(shell);
        // Continuations of one list item must not invent a new bullet/number.
        if (ancestor.tagName === "LI" && seenShells.has(ancestor)) shell.style.listStyle = "none";
        if (ancestor.tagName === "LI" && ancestor.parentElement?.tagName === "OL") {
          shell.setAttribute("value", String(orderedValues.get(ancestor) || 1));
        }
        seenShells.add(ancestor);
        target.append(shell);
        shells.set(ancestor, shell);
      }
      target = shell;
    }
    return target;
  }
  function take() {
    const result = holder.firstElementChild as HTMLElement;
    holder = document.createElement("div");
    shells = new Map();
    chars = 0; nodes = 0; lines = 0;
    return result;
  }
  function* append(node: Node, path: HTMLElement[]): Generator<HTMLElement> {
    const size = sizes.get(node)!;
    if (size.chars <= MAX_CHARS && size.nodes <= MAX_NODES && size.lines <= MAX_LINES) {
      if (nodes && (chars + size.chars > MAX_CHARS || nodes + size.nodes > MAX_NODES || lines + size.lines > MAX_LINES)) yield take();
      const clone = node.cloneNode(true);
      if (clone instanceof HTMLElement) {
        stripRepeatedIds(clone);
        if (orderedValues.has(node)) clone.setAttribute("value", String(orderedValues.get(node)));
      }
      parent(path).append(clone);
      chars += size.chars; nodes += size.nodes; lines += size.lines;
    } else if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || "";
      let offset = 0;
      while (offset < text.length) {
        if (nodes) yield take();
        let end = Math.min(text.length, offset + MAX_CHARS);
        let lineEnd = offset;
        for (let n = 0; n < MAX_LINES; n++) {
          const next = text.indexOf("\n", lineEnd);
          if (next < 0 || next >= end) break;
          lineEnd = next + 1;
          if (n === MAX_LINES - 1) end = lineEnd;
        }
        // Prefer a complete line or word; never split a UTF-16 surrogate pair.
        if (end < text.length) {
          const boundary = Math.max(text.lastIndexOf("\n", end - 1), text.lastIndexOf(" ", end - 1));
          if (boundary > offset + MAX_CHARS / 2) end = boundary + 1;
          if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
        }
        parent(path).append(document.createTextNode(text.slice(offset, end)));
        chars = end - offset; nodes = 1; lines = MAX_LINES; offset = end;
      }
    } else if (node instanceof HTMLElement) {
      for (const child of node.childNodes) yield* append(child, [...path, node]);
    }
  }
  yield* append(root, []);
  if (nodes) yield take();
}

/** Bound sanitizer batches, reducing parser setup overhead without constructing a full DOM. */
function* htmlBatches(source: string) {
  let html = "", groups = 0;
  for (const next of renderMarkdownChunks(source)) {
    if (html && (html.length + next.length > 32_768 || groups >= 64)) {
      yield html; html = ""; groups = 0;
    }
    html += next; groups++;
  }
  if (html) yield html;
}

export async function buildVirtualDocument(
  source: string,
  path: string,
  cancelled: () => boolean = () => false
): Promise<VirtualDocument> {
  const result: VirtualDocument = { blocks: [], headings: [], anchors: new Map(), codes: new Map() };
  const used = new Set<string>();
  let deadline = performance.now() + 8;
  let codeGroup = 0;
  let sourceGroup = 0;
  let storedCharacters = 0;
  for (const html of htmlBatches(source)) {
    if (cancelled()) throw new DOMException("Document replaced", "AbortError");
    const { fragment } = sanitizeDocumentHtml(html, path, result.headings, used);
    for (const child of Array.from(fragment.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE && !child.textContent?.trim()) continue;
      const element = child instanceof HTMLElement ? child : document.createElement("div");
      if (!(child instanceof HTMLElement)) element.append(child);
      const elementGroup = sourceGroup++;
      const isCode = element.classList.contains("code-block");
      const codeNodes = [element, ...element.querySelectorAll<HTMLElement>(".code-block")]
        .filter((node) => node.classList.contains("code-block"));
      for (const node of codeNodes) node.dataset.codeGroup = String(codeGroup++);
      const columns = element.classList.contains("table-wrap")
        ? Array.from(element.querySelector("tr")?.children || []).reduce((sum, cell) => sum + ((cell as HTMLTableCellElement).colSpan || 1), 0)
        : 0;
      for (const part of splitElement(element)) {
        // Shared fixed column widths prevent each table slice from independently
        // reflowing columns as different rows enter the viewport.
        if (part !== element && columns > 0 && columns <= 32) {
          const table = part.querySelector("table");
          if (table) {
            table.style.tableLayout = "fixed"; table.style.width = "100%";
            table.style.minWidth = `${columns * 100}px`;
            const group = document.createElement("colgroup");
            for (let i = 0; i < columns; i++) {
              const col = document.createElement("col"); col.style.width = `${100 / columns}%`; group.append(col);
            }
            table.prepend(group);
          }
        }
        const partCode = [part, ...part.querySelectorAll<HTMLElement>(".code-block")]
          .filter((node) => node.classList.contains("code-block"));
        for (const node of partCode) {
          if (node.querySelector("pre") && !node.querySelector(".code-copy")) {
            const copy = document.createElement("button");
            copy.type = "button"; copy.className = "code-copy";
            copy.title = "复制完整代码"; copy.setAttribute("aria-label", "复制完整代码");
            node.append(copy);
          }
        }
        const index = result.blocks.length;
        for (const anchor of [part, ...part.querySelectorAll<HTMLElement>("[id]")]) {
          if (anchor.id && !result.anchors.has(anchor.id)) result.anchors.set(anchor.id, index);
        }
        const serialized = part.outerHTML;
        storedCharacters += serialized.length;
        if (storedCharacters > 16 * 1024 * 1024 || index >= 60_000)
          throw new Error("虚拟文档超过 16 Mi 字符或 60000 块预算，请拆分后阅读。");
        result.blocks.push({
          html: serialized,
          group: elementGroup,
          text: part.textContent || "",
          kind: isCode ? "code" : /^H[1-6]$/.test(part.tagName) ? "heading" : "prose",
        });
        // Copy indices reference the existing block text, including nested code in
        // quotes/lists. No second full-code string or detached pre is retained.
        if (partCode.length) {
          const walker = document.createTreeWalker(part, NodeFilter.SHOW_TEXT);
          let offset = 0, textNode: Node | null;
          while ((textNode = walker.nextNode())) {
            const length = textNode.textContent?.length || 0;
            const pre = textNode.parentElement?.closest("pre");
            const code = pre?.closest<HTMLElement>(".code-block[data-code-group]");
            if (code && length) {
              const group = Number(code.dataset.codeGroup);
              const slices = result.codes.get(group) || [];
              const previous = slices[slices.length - 1];
              if (previous?.block === index && previous.start + previous.length === offset) previous.length += length;
              else slices.push({ block: index, start: offset, length });
              result.codes.set(group, slices);
            }
            offset += length;
          }
        }
        // Time-sliced sanitation/serialization; cancellation releases partial results.
        if (performance.now() >= deadline) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          if (cancelled()) throw new DOMException("Document replaced", "AbortError");
          deadline = performance.now() + 8;
        }
      }
    }
  }
  return result;
}
