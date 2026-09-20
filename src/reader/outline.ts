import type { Heading } from "./document";

export interface OutlineEntry extends Heading {
  ancestors: string[];
  depth: number;
  children: boolean;
}

// Use actual ancestry, not H-level subtraction: skipped levels remain navigable.
export function buildOutline(headings: Heading[]): OutlineEntry[] {
  const stack: OutlineEntry[] = [];
  return headings.map((heading) => {
    while (stack.length && stack[stack.length - 1].level >= heading.level)
      stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parent.children = true;
    const entry: OutlineEntry = {
      ...heading,
      ancestors: stack.map((item) => item.id),
      depth: stack.length,
      children: false,
    };
    stack.push(entry);
    return entry;
  });
}

export function filterOutline(
  entries: OutlineEntry[],
  maxLevel: number,
  collapsed: Set<string>,
  query: string
): OutlineEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle) {
    // Searching deliberately ignores level/collapse filters, keeping ancestor context.
    const visible = new Set<string>();
    for (const entry of entries) {
      if (entry.text.toLocaleLowerCase().includes(needle)) {
        visible.add(entry.id);
        entry.ancestors.forEach((id) => visible.add(id));
      }
    }
    return entries.filter((entry) => visible.has(entry.id));
  }
  return entries.filter(
    (entry) =>
      entry.level <= maxLevel &&
      !entry.ancestors.some((id) => collapsed.has(id))
  );
}
