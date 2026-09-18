/**
 * 阅读历史（模块级单例）：最近打开文件列表（欢迎页展示）+ 按路径记忆的
 * 滚动位置（重开文件恢复到上次读的地方）。均存 localStorage。
 */

import { ref } from "vue";

const STORAGE_RECENT = "md-reader-recent";
const STORAGE_SCROLL = "md-reader-scroll-positions";
const MAX_RECENT = 20;
const MAX_SCROLL_ENTRIES = 100;

export interface RecentItem {
  path: string;
  name: string;
  ts: number;
}

function loadRecent(): RecentItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_RECENT);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return [];
}

function loadScrollMap(): Record<string, number> {
  try {
    const raw = localStorage.getItem(STORAGE_SCROLL);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return {};
}

const recent = ref<RecentItem[]>(loadRecent());
const scrollMap = ref<Record<string, number>>(loadScrollMap());

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1];
}

/** 记录「最近打开」：去重后插到队首，截断到上限。 */
function pushRecent(path: string) {
  if (!path) return;
  const list = recent.value.filter((x) => x.path !== path);
  list.unshift({ path, name: basename(path), ts: Date.now() });
  recent.value = list.slice(0, MAX_RECENT);
  localStorage.setItem(STORAGE_RECENT, JSON.stringify(recent.value));
}

function clearRecent() {
  recent.value = [];
  localStorage.setItem(STORAGE_RECENT, "[]");
}

/**
 * 记录文件滚动位置。条目超上限时优先淘汰不在最近列表里的路径
 * （最近打开的文件其阅读位置更值得保留）。
 */
function saveScroll(path: string, top: number) {
  if (!path) return;
  scrollMap.value[path] = top;
  const recentPaths = new Set(recent.value.map((x) => x.path));
  for (const key of Object.keys(scrollMap.value)) {
    if (Object.keys(scrollMap.value).length <= MAX_SCROLL_ENTRIES) break;
    if (!recentPaths.has(key)) delete scrollMap.value[key];
  }
  localStorage.setItem(STORAGE_SCROLL, JSON.stringify(scrollMap.value));
}

function getScroll(path: string): number {
  return scrollMap.value[path] || 0;
}

export function useHistory() {
  return { recent, pushRecent, clearRecent, saveScroll, getScroll };
}
