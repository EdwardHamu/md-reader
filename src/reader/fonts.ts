// Reader font preferences: ordered candidate families chosen from the
// system-installed font list. Persistence follows the existing
// localStorage pattern (reader-theme / reader-font-size).
import { computed, ref, shallowRef } from "vue";
import { invoke } from "@tauri-apps/api/core";

const STORAGE_KEY = "reader-font-families";
const MAX_CANDIDATES = 6;
// Keep the shipped stack as the tail so unresolved candidates degrade
// exactly to the previous rendering.
export const DEFAULT_STACK =
  '"Segoe UI", "Microsoft YaHei", system-ui, sans-serif';

function sanitize(names: unknown): string[] {
  if (!Array.isArray(names)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of names) {
    if (typeof name !== "string") continue;
    const trimmed = name.trim().slice(0, 120);
    // Font family names never need quotes/backslashes; dropping them
    // keeps the generated font-family value unambiguous.
    const safe = trimmed.replace(/["'\\;{}<>]/g, "");
    if (!safe || seen.has(safe)) continue;
    seen.add(safe);
    result.push(safe);
    if (result.length >= MAX_CANDIDATES) break;
  }
  return result;
}

export function loadSavedFamilies(): string[] {
  try {
    return sanitize(JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"));
  } catch {
    return [];
  }
}

export function useReaderFonts() {
  const families = ref<string[]>(loadSavedFamilies());
  const systemFonts = shallowRef<string[]>([]);
  const fontsLoading = ref(false);
  const fontsError = ref("");
  let loaded = false;

  const fontFamily = computed(() => {
    if (!families.value.length) return "";
    const quoted = families.value.map((name) => `"${name}"`).join(", ");
    return `${quoted}, ${DEFAULT_STACK}`;
  });

  function persist() {
    try {
      if (families.value.length)
        localStorage.setItem(STORAGE_KEY, JSON.stringify(families.value));
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* Reading still works with unavailable preference storage. */
    }
  }

  async function ensureSystemFonts() {
    if (loaded || fontsLoading.value) return;
    fontsLoading.value = true;
    fontsError.value = "";
    try {
      const names = await invoke<string[]>("list_system_fonts");
      systemFonts.value = names;
      loaded = true;
    } catch (failure) {
      fontsError.value = `无法读取系统字体：${String(failure)}`;
    } finally {
      fontsLoading.value = false;
    }
  }

  function toggle(name: string) {
    const next = families.value.filter((item) => item !== name);
    if (next.length === families.value.length) {
      if (next.length >= MAX_CANDIDATES) return;
      next.push(name);
    }
    families.value = sanitize(next);
    persist();
  }

  function move(name: string, delta: -1 | 1) {
    const index = families.value.indexOf(name);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= families.value.length) return;
    const next = [...families.value];
    [next[index], next[target]] = [next[target], next[index]];
    families.value = next;
    persist();
  }

  function reset() {
    families.value = [];
    persist();
  }

  return {
    families,
    systemFonts,
    fontsLoading,
    fontsError,
    fontFamily,
    maxCandidates: MAX_CANDIDATES,
    ensureSystemFonts,
    toggle,
    move,
    reset,
  };
}
