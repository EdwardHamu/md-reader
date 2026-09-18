/**
 * 多标签状态（模块级单例：tabs 数组 + activeTabId，跨组件共享）。
 *
 * 架构约束（AGENTS.md 记录）：只有一个共享的 MarkdownView/MarkdownEditor
 * 实例，切标签是重渲染而非换组件。所以每个 Tab 自带「恢复现场」的三元组：
 * - scrollTop：上次离开时的像素位置
 * - pendingHash / pendingScrollTop / pendingSourceLine：渲染完成后要跳到
 *   哪里（App.vue 的 onRendered 消费，优先级 hash > 源码行 > scrollTop）
 * 标签列表持久化到 localStorage（只存路径 + 活动路径，内容启动时重读）。
 */

import { ref, computed } from "vue";
import type { Heading } from "./useMarkdown";

const STORAGE_TABS = "md-reader-tabs";

export interface Tab {
  id: string;
  /** 文件绝对路径（标签的唯一身份）。 */
  path: string;
  /** 磁盘上的内容（脏标记的比较基准）。 */
  content: string;
  /** 草稿内容（正在编辑/渲染的版本）。 */
  draftContent: string;
  /** 草稿与磁盘内容不一致。 */
  isDirty: boolean;
  /** 处于编辑态（CodeMirror）而非预览态。 */
  isEditing: boolean;
  headings: Heading[];
  /** 上次离开时的阅读区滚动位置。 */
  scrollTop: number;
  // 渲染完成后的滚动恢复指令（onRendered 消费并清零）
  pendingHash: string;
  pendingScrollTop: number;
  pendingSourceLine: number;
}

interface PersistedTabs {
  paths: string[];
  activePath: string;
}

const tabs = ref<Tab[]>([]);
const activeTabId = ref<string>("");

let idSeq = 0;
function nextId(): string {
  idSeq += 1;
  return `tab-${Date.now()}-${idSeq}`;
}

/** 路径归一化：反斜杠→正斜杠 + 小写（Windows 大小写不敏感）。 */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

/** 路径等价判断（经 normalizePath 归一化后比较）。 */
export function samePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

const activeTab = computed<Tab | null>(
  () => tabs.value.find((t) => t.id === activeTabId.value) ?? null
);

function findTabByPath(path: string): Tab | undefined {
  return tabs.value.find((t) => samePath(t.path, path));
}

/** 创建空白标签（内容由调用方 readFileIntoTab 填充）。 */
function createTab(path: string): Tab {
  return {
    id: nextId(),
    path,
    content: "",
    draftContent: "",
    isDirty: false,
    isEditing: false,
    headings: [],
    scrollTop: 0,
    pendingHash: "",
    pendingScrollTop: 0,
    pendingSourceLine: 0,
  };
}

function activateTab(id: string) {
  if (tabs.value.some((t) => t.id === id)) {
    activeTabId.value = id;
    persist();
  }
}

/** 移除标签；关掉的是活动标签时，激活相邻标签（优先右侧，末尾回退左侧）。 */
function removeTab(id: string) {
  const idx = tabs.value.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const wasActive = activeTabId.value === id;
  tabs.value.splice(idx, 1);
  if (wasActive) {
    const next = tabs.value[idx] ?? tabs.value[idx - 1] ?? null;
    activeTabId.value = next ? next.id : "";
  }
  persist();
}

/** 持久化标签列表（只存路径；下次启动重读文件内容）。 */
function persist() {
  const data: PersistedTabs = {
    paths: tabs.value.map((t) => t.path),
    activePath: activeTab.value?.path ?? "",
  };
  localStorage.setItem(STORAGE_TABS, JSON.stringify(data));
}

function loadPersisted(): PersistedTabs | null {
  try {
    const raw = localStorage.getItem(STORAGE_TABS);
    if (raw) return JSON.parse(raw) as PersistedTabs;
  } catch {
    /* ignore */
  }
  return null;
}

export function useTabs() {
  return {
    tabs,
    activeTabId,
    activeTab,
    findTabByPath,
    createTab,
    activateTab,
    removeTab,
    persist,
    loadPersisted,
  };
}
