export const isMarkdownPath = (path: string) =>
  /\.(md|markdown|mdx|txt)$/i.test(path);
export const isSafeExternal = (url: string) =>
  /^(https?:\/\/|mailto:)/i.test(url);

export function fileUrl(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const encoded = normalized
    .split("/")
    .map((part, i) =>
      i === 0 && /^[a-z]:$/i.test(part) ? part : encodeURIComponent(part)
    )
    .join("/");
  return normalized.startsWith("//")
    ? `file:${encoded}`
    : `file://${normalized.startsWith("/") ? "" : "/"}${encoded}`;
}

/** URL resolution handles .., spaces, Unicode, drive letters and UNC without lossy splitting. */
export function resolveLocalLink(
  currentFile: string,
  href: string
): { path: string; hash: string } | null {
  try {
    let normalized = href.replace(/\\/g, "/");
    if (/^[a-z]:\//i.test(normalized)) normalized = fileUrl(normalized);
    else if (href.startsWith("\\\\")) normalized = fileUrl(href);
    const url = new URL(normalized, fileUrl(currentFile));
    if (url.protocol !== "file:") return null;
    let path = decodeURIComponent(url.pathname);
    if (url.hostname) path = `//${url.hostname}${path}`;
    else if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
    return { path, hash: url.hash.slice(1) };
  } catch {
    return null;
  }
}

export function findAnchor(root: HTMLElement, hash: string): HTMLElement | null {
  let decoded = hash;
  try {
    decoded = decodeURIComponent(hash);
  } catch {
    /* Malformed escapes remain literal. */
  }
  // Exact first: heading IDs may themselves contain percent escapes.
  for (const id of [hash, decoded]) {
    const target = root.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`);
    if (target) return target;
  }
  return null;
}

export function scrollToHash(
  root: HTMLElement,
  hash: string,
  options: { smooth?: boolean } = {}
): boolean {
  const target = findAnchor(root, hash);
  if (!target) return false;
  const reduced = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;
  target.scrollIntoView({
    block: "start",
    behavior: options.smooth && !reduced ? "smooth" : "auto",
  });
  // Flash the landing block so the eye finds the new viewport position.
  if (!reduced) {
    target.classList.remove("anchor-flash");
    void target.offsetWidth; // Restart the animation on repeated jumps.
    target.classList.add("anchor-flash");
    target.addEventListener(
      "animationend",
      () => target.classList.remove("anchor-flash"),
      { once: true }
    );
  }
  return true;
}

/** Obsidian-style trailing block anchor: "text ^block-id" (space required). */
export function splitBlockAnchor(
  text: string
): { text: string; id: string } | null {
  const match = /^([\s\S]*?)[ \t]\^([A-Za-z0-9][A-Za-z0-9_-]{0,63})\s*$/.exec(
    text
  );
  if (!match) return null;
  return { text: match[1].replace(/[ \t]+$/, ""), id: `^${match[2]}` };
}
