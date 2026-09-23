import type { ReadingAnchor } from "./virtual-reader";

const STORAGE_KEY = "reader-reading-progress-v1";
const MAX_FILES = 100;

interface ProgressStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function isAnchor(value: unknown): value is ReadingAnchor {
  if (!value || typeof value !== "object") return false;
  const { block, offset } = value as Partial<ReadingAnchor>;
  return Number.isSafeInteger(block) && block! >= 0 &&
    typeof offset === "number" && Number.isFinite(offset) && offset >= 0;
}

/** Keep only positions, never source text or document DOM. Oldest entry goes first. */
export function createReadingProgressStore(storage: ProgressStorage | null) {
  const positions = new Map<string, ReadingAnchor>();
  let newest = "";
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    // Ignore implausibly large/corrupted values instead of parsing them at startup.
    const saved: unknown = raw && raw.length <= 4 * 1024 * 1024 ? JSON.parse(raw) : null;
    if (Array.isArray(saved)) {
      for (const entry of saved) {
        if (!entry || typeof entry !== "object") continue;
        const { path, anchor } = entry as { path?: unknown; anchor?: unknown };
        if (typeof path !== "string" || !path || !isAnchor(anchor)) continue;
        positions.delete(path);
        positions.set(path, { block: anchor.block, offset: anchor.offset });
        newest = path;
        if (positions.size > MAX_FILES) positions.delete(positions.keys().next().value!);
      }
    }
  } catch {
    // Unavailable or malformed storage must never prevent opening a document.
  }

  let dirty = false;
  return {
    get(path: string): ReadingAnchor | undefined {
      const anchor = positions.get(path);
      return anchor && { ...anchor };
    },
    remember(path: string, anchor: ReadingAnchor): boolean {
      if (!path || !isAnchor(anchor)) return false;
      const previous = positions.get(path);
      if (newest === path && previous?.block === anchor.block && previous.offset === anchor.offset) return false;
      positions.delete(path);
      positions.set(path, { block: anchor.block, offset: anchor.offset });
      newest = path;
      if (positions.size > MAX_FILES) positions.delete(positions.keys().next().value!);
      dirty = true;
      return true;
    },
    flush() {
      if (!dirty || !storage) return;
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(
          [...positions].map(([path, anchor]) => ({ path, anchor }))
        ));
        dirty = false;
      } catch {
        // Quota/security errors leave the in-memory positions usable.
      }
    },
  };
}
