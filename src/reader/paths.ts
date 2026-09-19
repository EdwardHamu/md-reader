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

export function scrollToHash(root: HTMLElement, hash: string): void {
  let decoded = hash;
  try {
    decoded = decodeURIComponent(hash);
  } catch {
    /* Malformed escapes remain literal. */
  }
  // Exact first: heading IDs may themselves contain percent escapes.
  for (const id of [hash, decoded]) {
    const target = root.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`);
    if (target) {
      target.scrollIntoView({ block: "start" });
      return;
    }
  }
}
