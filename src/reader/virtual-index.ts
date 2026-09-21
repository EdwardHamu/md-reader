/** Mutable prefix sums: measurements and viewport lookup are O(log n). No DOM references. */
export class HeightIndex {
  private tree: Float64Array;
  private values: Float64Array;
  constructor(heights: number[]) {
    this.values = Float64Array.from(heights, (height) => Math.max(1, height));
    this.tree = new Float64Array(heights.length + 1);
    for (let i = 0; i < heights.length; i++) {
      this.tree[i + 1] += this.values[i];
      const parent = (i + 1) + ((i + 1) & -(i + 1));
      if (parent < this.tree.length) this.tree[parent] += this.tree[i + 1];
    }
  }
  get length() { return this.values.length; }
  get total() { return this.prefix(this.length); }
  height(index: number) { return this.values[index] || 0; }
  prefix(end: number) {
    let sum = 0;
    for (let i = Math.min(this.length, Math.max(0, end)); i > 0; i -= i & -i)
      sum += this.tree[i];
    return sum;
  }
  set(index: number, height: number) {
    if (index < 0 || index >= this.length || !Number.isFinite(height)) return;
    const value = Math.max(1, height);
    const delta = value - this.values[index];
    this.values[index] = value;
    for (let i = index + 1; i < this.tree.length; i += i & -i) this.tree[i] += delta;
  }
  at(offset: number) {
    let index = 0, sum = 0;
    let step = 1;
    while (step * 2 <= this.length) step *= 2;
    for (; step; step = Math.floor(step / 2)) {
      const next = index + step;
      if (next <= this.length && sum + this.tree[next] <= Math.max(0, offset)) {
        index = next;
        sum += this.tree[next];
      }
    }
    return Math.min(index, Math.max(0, this.length - 1));
  }
  window(top: number, viewport: number, buffer: number) {
    if (!this.length) return { start: 0, end: 0 };
    return {
      start: this.at(Math.max(0, top - buffer)),
      end: Math.min(this.length, this.at(top + viewport + buffer) + 1),
    };
  }
}

export interface TextMatch { block: number; start: number; length: number; endBlock?: number; end?: number }
export function findText(blocks: readonly { text: string; group?: number }[], query: string, limit = 1000) {
  const matches: TextMatch[] = [];
  if (!query) return { matches, limited: false };
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  let resumeBlock = -1, resumeOffset = 0;
  for (let block = 0; block < blocks.length; block++) {
    if (block < resumeBlock) continue;
    const own = blocks[block].text;
    if (!own.length) continue;
    let text = own;
    // Look ahead only inside one original semantic block, so a phrase crossing a
    // virtual slice is found without inventing matches across unrelated paragraphs.
    let next = block + 1, remaining = query.length - 1;
    while (remaining > 0 && next < blocks.length && blocks[block].group !== undefined && blocks[next].group === blocks[block].group) {
      const tail = blocks[next++].text.slice(0, remaining);
      text += tail; remaining -= tail.length;
    }
    expression.lastIndex = block === resumeBlock ? resumeOffset : 0;
    let match: RegExpExecArray | null;
    while ((match = expression.exec(text))) {
      if (match.index >= own.length) break;
      if (matches.length === limit) return { matches, limited: true };
      let endBlock = block, end = match.index + match[0].length;
      while (end > blocks[endBlock].text.length && endBlock + 1 < blocks.length) {
        end -= blocks[endBlock++].text.length;
      }
      resumeBlock = endBlock; resumeOffset = end;
      matches.push({ block, start: match.index, length: match[0].length,
        ...(endBlock !== block ? { endBlock, end } : {}),
      });
    }
  }
  return { matches, limited: false };
}
