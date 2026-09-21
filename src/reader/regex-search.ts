import type { TextMatch } from "./virtual-index";

/** Run arbitrary regex only inside a terminable worker. */
export function findRegex(blocks: readonly { text: string; group?: number }[], query: string, limit = 1000) {
  const matches: TextMatch[] = [];
  if (!query) return { matches, limited: false };
  const expression = new RegExp(query, "gimu");
  for (let first = 0; first < blocks.length;) {
    let last = first + 1;
    while (last < blocks.length && blocks[first].group !== undefined && blocks[last].group === blocks[first].group) last++;
    const starts = [0];
    let text = "";
    for (let i = first; i < last; i++) { text += blocks[i].text; starts.push(text.length); }
    function location(offset: number) {
      let low = 0, high = last - first - 1;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (starts[mid] <= offset) low = mid; else high = mid - 1;
      }
      return { block: first + low, offset: offset - starts[low] };
    }
    expression.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = expression.exec(text))) {
      // Empty matches have no visible highlight. Advance a Unicode code point.
      if (!match[0].length) {
        expression.lastIndex = match.index + ((text.codePointAt(match.index) || 0) > 0xffff ? 2 : 1);
        continue;
      }
      if (matches.length >= limit) return { matches, limited: true };
      const start = location(match.index), end = location(match.index + match[0].length - 1);
      matches.push({ block: start.block, start: start.offset, length: match[0].length,
        ...(end.block !== start.block ? { endBlock: end.block, end: end.offset + 1 } : {}) });
    }
    first = last;
  }
  return { matches, limited: false };
}
