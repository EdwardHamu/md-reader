import type { VirtualBlock, VirtualDocument } from "./virtual-document";

const MAX_BLOCK_CHARS = 6000;
const MAX_BLOCK_LINES = 80;

// Preserve the source, including empty lines, CRLF and UTF-16 surrogate pairs.
// Keep the tail until the next IPC chunk so a chunk boundary is not a line break.
function blockEnd(text: string, start: number, final: boolean) {
  let end = Math.min(text.length, start + MAX_BLOCK_CHARS);
  const window = text.slice(start, end);
  let afterLine = 0;
  for (let lines = 1; lines <= MAX_BLOCK_LINES; lines++) {
    const newline = window.indexOf("\n", afterLine);
    if (newline < 0) break;
    afterLine = newline + 1;
    if (lines === MAX_BLOCK_LINES) return start + afterLine;
  }
  if (end === text.length && !final) return start;
  if (end < text.length) {
    if (afterLine >= MAX_BLOCK_CHARS / 2) return start + afterLine;
    if (/[\uD800-\uDBFF]/.test(text[end - 1]) || (text[end - 1] === "\r" && text[end] === "\n")) end--;
  }
  return end;
}

/** Store one copy of the text, not a duplicate HTML cache or a document-sized DOM. */
export async function buildTextVirtualDocument(
  chunks: AsyncIterable<string> | Iterable<string>,
  cancelled: () => boolean = () => false
): Promise<VirtualDocument> {
  const blocks: VirtualBlock[] = [];
  let tail = "", first = true, deadline = performance.now() + 8;
  function check() {
    if (cancelled()) throw new DOMException("Document replaced", "AbortError");
  }
  async function index(text: string, final: boolean) {
    check();
    let start = 0;
    while (start < text.length) {
      const end = blockEnd(text, start, final);
      if (end === start) break;
      blocks.push({ html: null, group: 0, text: text.slice(start, end), kind: "prose" });
      start = end;
      if (performance.now() >= deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        check();
        deadline = performance.now() + 8;
      }
    }
    return text.slice(start);
  }
  check();
  for await (const chunk of chunks) {
    if (!chunk) continue;
    tail = await index(tail + (first ? chunk.replace(/^\uFEFF/, "") : chunk), false);
    first = false;
  }
  await index(tail, true);
  return { blocks, headings: [], anchors: new Map(), codes: new Map(), textOnly: true };
}
