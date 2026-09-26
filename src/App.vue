<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { createWindowReveal } from "./reader/reveal";
import { createLatestLoader } from "./reader/latest";
import {
  isMarkdownPath,
  isSafeExternal,
  resolveLocalLink,
} from "./reader/paths";
import { useFind } from "./reader/find";
import { createReadingKeys, isEditingTarget } from "./reader/keyboard";
import { useReaderFonts } from "./reader/fonts";
import { useJumpHistory } from "./reader/history";
import { useHoverPreview } from "./reader/preview";
import { createReadingProgressStore } from "./reader/progress";
import type { Heading } from "./reader/document";
import { createVirtualReader, type VirtualReader, type ReadingAnchor } from "./reader/virtual-reader";

import ReaderIcon from "./components/ReaderIcon.vue";
import DocumentOutline from "./components/DocumentOutline.vue";
import PreviewContent from "./components/PreviewContent.vue";

interface DocumentData {
  path: string;
  source: string;
}
interface OpenRequest {
  path: string;
  hash: string;
}
const body = shallowRef<HTMLElement | null>(null);
const headings = shallowRef<Heading[]>([]);
const currentFile = ref("");
const loading = ref(false);
const editing = ref(false);
const saving = ref(false);
const editSource = ref("");
const originalSource = ref("");
const dirty = computed(() => editing.value && editSource.value !== originalSource.value);
const editor = shallowRef<HTMLTextAreaElement | null>(null);
// Reading position captured right before the article is hidden for editing.
let editAnchor: ReadingAnchor | undefined;
function canLeaveEdit() {
  return !saving.value && (!dirty.value || window.confirm("编辑内容尚未保存，确定放弃修改吗？"));
}
async function startEditing() {
  if (!currentFile.value || editing.value || loading.value) return;
  const path = currentFile.value;
  try {
    const data = await invoke<DocumentData>("read_document", { path });
    if (disposed || currentFile.value !== path || loading.value) return;
    // Keep the source only during editing; normal reading remains bounded and virtualized.
    originalSource.value = data.source;
    editSource.value = data.source;
    // Capture BEFORE hiding the article: a hidden article has no geometry, so any
    // capture() while editing would produce (and persist) a bogus position.
    editAnchor = virtualReader?.capture();
    flushPosition();
    positionReady = false;
    editing.value = true;
    closeFind();
    await nextTick();
    editor.value?.focus();
  } catch (failure) { error.value = `无法进入编辑模式：${String(failure)}`; }
}
function stopEditing() {
  if (!canLeaveEdit()) return;
  editing.value = false;
  editSource.value = "";
  originalSource.value = "";
  restoreAfterEditing();
}
/** The article is visible again after the next DOM update: re-measure, then restore. */
function restoreAfterEditing() {
  const anchor = editAnchor;
  const view = virtualReader;
  editAnchor = undefined;
  void nextTick(() => {
    if (disposed || editing.value || !view || virtualReader !== view) return;
    // Heights may have been re-estimated with a zero width while hidden.
    view.invalidate();
    if (anchor) view.restore(anchor);
    positionReady = true;
    schedulePosition();
    readingArea.value?.focus({ preventScroll: true });
  });
}
async function saveEditing() {
  if (!editing.value || saving.value || !currentFile.value) return;
  const path = currentFile.value;
  const source = editSource.value;
  saving.value = true;
  let saved = false;
  try {
    await invoke("save_document", { path, source, expected: originalSource.value });
    saved = true;
  } catch (failure) { error.value = `保存失败：${String(failure)}`; }
  finally { saving.value = false; }
  // Reload only after `saving` is cleared: canLeaveEdit() (called by loadFile) rejects while saving.
  if (!saved || disposed || currentFile.value !== path) return;
  editing.value = false;
  editSource.value = "";
  originalSource.value = "";
  // The reload restores the progress flushed in startEditing() (positionReady stays false until then).
  editAnchor = undefined;
  loadFile(path);
}
const error = ref("");
const tocVisible = ref(true);
const readingArea = shallowRef<HTMLElement | null>(null);
const activeId = ref("");
const progress = ref(0);
const fileName = computed(
  () =>
    currentFile.value.replace(/\\/g, "/").split("/").pop() || "开启一段专注时光"
);
const pathCopied = ref(false);
let pathCopiedTimer: ReturnType<typeof setTimeout> | undefined;
async function copyCurrentPath() {
  const path = currentFile.value;
  if (!path) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(path);
    } else {
      const input = document.createElement("textarea");
      input.value = path;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      const ok = document.execCommand("copy");
      input.remove();
      if (!ok) throw new Error("execCommand failed");
    }
    pathCopied.value = true;
    clearTimeout(pathCopiedTimer);
    pathCopiedTimer = setTimeout(() => (pathCopied.value = false), 1500);
  } catch (failure) {
    error.value = `复制路径失败：${String(failure)}`;
  }
}
let virtualReader: VirtualReader | undefined;
const virtualized = ref(false);
let scrollFrame = 0;
const readingProgress = createReadingProgressStore((() => {
  try { return window.localStorage; } catch { return null; }
})());
let positionReady = false;
let progressTimer = 0;
function rememberPosition() {
  if (!positionReady || !currentFile.value || !virtualReader) return false;
  return readingProgress.remember(currentFile.value, virtualReader.capture());
}
function scheduleProgressFlush() {
  window.clearTimeout(progressTimer);
  progressTimer = window.setTimeout(() => {
    progressTimer = 0;
    readingProgress.flush();
  }, 500);
}
function flushPosition() {
  window.clearTimeout(progressTimer);
  progressTimer = 0;
  rememberPosition();
  readingProgress.flush();
}
function flushWhenHidden() {
  if (document.visibilityState === "hidden") flushPosition();
}
function updatePosition() {
  scrollFrame = 0;
  const area = readingArea.value;
  // While editing, the reading area scrolls the textarea, not the hidden article.
  if (!area || !currentFile.value || editing.value) return;
  const range = area.scrollHeight - area.clientHeight;
  progress.value = range > 0 ? Math.round((area.scrollTop / range) * 100) : 100;
  activeId.value = virtualReader?.activeHeading() || "";
  if (rememberPosition()) scheduleProgressFlush();
}
function schedulePosition() {
  if (!scrollFrame) scrollFrame = requestAnimationFrame(updatePosition);
}
const findInput = shallowRef<HTMLInputElement | null>(null);
const find = useFind(() => virtualReader);
const readingKeys = createReadingKeys();
function resetReadingKeys() { readingKeys.reset(); }
function closeFind() {
  const restoreFocus = findVisible.value;
  find.close();
  if (restoreFocus) readingArea.value?.focus({ preventScroll: true });
}
const {
  query,
  visible: findVisible,
  count: findCount,
  limited: findLimited,
} = find;
let disposed = false;
let interaction = 0;
const cleanup: UnlistenFn[] = [];
function saved(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
const themePreference = saved("reader-theme");
const dark = ref(
  themePreference === "dark" ||
    (themePreference !== "light" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches)
);
const startupReveal = createWindowReveal(() =>
  invoke("reveal_main_window", { dark: dark.value })
);
const fontSize = ref(
  Math.max(12, Math.min(28, Number(saved("reader-font-size")) || 17))
);
const fonts = useReaderFonts();
const fontPanelVisible = ref(false);
const fontQuery = ref("");
const filteredFonts = computed(() => {
  const query = fontQuery.value.trim().toLowerCase();
  const names = fonts.systemFonts.value;
  if (!query) return names.slice(0, 400);
  return names
    .filter((name) => name.toLowerCase().includes(query))
    .slice(0, 400);
});
function toggleFontPanel() {
  fontPanelVisible.value = !fontPanelVisible.value;
  if (fontPanelVisible.value) void fonts.ensureSystemFonts();
}
function quoteFamily(name: string) {
  return `"${name}"`;
}
function savePreferences() {
  document.documentElement.dataset.theme = dark.value ? "dark" : "light";
  try {
    localStorage.setItem("reader-theme", dark.value ? "dark" : "light");
    localStorage.setItem("reader-font-size", String(fontSize.value));
  } catch {
    /* Reading still works with unavailable preference storage. */
  }
}
// No synchronous preference writes on the first-render critical path.
document.documentElement.dataset.theme = dark.value ? "dark" : "light";
function changeFont(delta: number) {
  fontSize.value = Math.max(12, Math.min(28, fontSize.value + delta));
  savePreferences();
}
function clearDocument() {
  flushPosition();
  positionReady = false;
  readingKeys.reset();
  find.reset(); // Ranges must be released before detaching their DOM.
  headings.value = [];
  virtualReader?.dispose();
  virtualReader = undefined;
  virtualized.value = false;
  activeId.value = "";
  progress.value = 0;
  cancelAnimationFrame(scrollFrame);
  scrollFrame = 0;
  body.value?.replaceChildren();
  currentFile.value = "";
}
const loader = createLatestLoader(
  async (request: OpenRequest) => {
    // Parser/highlighting are absent from the startup chunk. No worker/second JS heap.
    // Start disk IPC and the lazy parser together, rather than paying both waits in series.
    // Settle BOTH even on failure: never release the latest-only queue while disk I/O is in flight.
    const revision = interaction;
    const [renderer, data] = await Promise.allSettled([
      import("./reader/virtual-document"),
      invoke<DocumentData>("read_document", { path: request.path }),
    ]);
    if (data.status === "rejected") throw data.reason;
    if (renderer.status === "rejected") throw renderer.reason;
    if (disposed || revision !== interaction) throw new DOMException("Document replaced", "AbortError");
    const model = await renderer.value.buildVirtualDocument(data.value.source, data.value.path,
      () => disposed || revision !== interaction);
    return { path: data.value.path, model };
  },
  ({ path, model }, request) => {
    if (!body.value || !readingArea.value) return;
    positionReady = false;
    currentFile.value = path;
    headings.value = model.headings;
    readingArea.value.scrollTop = 0;
    virtualReader = createVirtualReader(body.value, readingArea.value, model, () => {
      find.refresh();
      schedulePosition();
    });
    virtualized.value = virtualReader.virtual;
    if (!performance.getEntriesByName("reader:first-document").length) {
      performance.mark("reader:first-document");
    }
    const view = virtualReader;
    const restoreTop = pendingScrollTop;
    const restoreAnchor = pendingAnchor;
    const remembered = readingProgress.get(path);
    pendingScrollTop = -1;
    pendingAnchor = undefined;
    void nextTick(() => {
      if (virtualReader !== view) return;
      view.refresh();
      if (restoreAnchor) view.restore(restoreAnchor);
      else if (restoreTop >= 0 && readingArea.value) {
        readingArea.value.scrollTop = restoreTop;
        view.refresh();
      } else if (request.hash) view.jump(request.hash);
      else if (remembered) view.restore(remembered);
      positionReady = true;
      schedulePosition();
      startupReveal.ready();
    });
    // Only serialized blocks/text remain; source, tokens and temporary DOM are released.
    document.title = `${path.replace(/\\/g, "/").split("/").pop()} — MD Reader`;
  },
  (failure) => {
    error.value = String(failure);
  },
  () => {
    loading.value = false;
    void nextTick(() => startupReveal.ready());
  }
);
function loadFile(path: string, hash = "") {
  if (disposed || !canLeaveEdit()) return;
  editing.value = false; editSource.value = ""; originalSource.value = ""; editAnchor = undefined;
  ++interaction;
  preview.dispose();
  clearDocument();
  error.value = "";
  loading.value = true;
  document.title = "MD Reader";
  loader.request({ path, hash });
}
function closeDocument() {
  if (!canLeaveEdit()) return;
  editing.value = false; editSource.value = ""; originalSource.value = ""; editAnchor = undefined;
  ++interaction;
  loader.cancel();
  preview.dispose();
  history.clear();
  pendingScrollTop = -1;
  pendingAnchor = undefined;
  clearDocument();
  loading.value = false;
  error.value = "";
  document.title = "MD Reader";
}
async function chooseFile() {
  try {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [
        {
          name: "Markdown / 文本",
          extensions: ["md", "markdown", "mdx", "txt"],
        },
      ],
    });
    if (typeof selected === "string" && !disposed) loadFile(selected);
  } catch (failure) {
    if (!disposed) error.value = String(failure);
  }
}
function onFindEnter(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return;
  event.preventDefault(); find.move(event.shiftKey ? -1 : 1);
}
async function showFind(regex = false) {
  find.regex.value = regex;
  findVisible.value = true;
  await nextTick();
  findInput.value?.focus();
  findInput.value?.select();
  if (query.value) find.search();
}
const history = useJumpHistory(
  () =>
    currentFile.value && readingArea.value
      ? { path: currentFile.value, scrollTop: readingArea.value.scrollTop, anchor: virtualReader?.capture() }
      : null,
  (entry) => {
    if (entry.path === currentFile.value) {
      if (entry.anchor) virtualReader?.restore(entry.anchor);
      else readingArea.value?.scrollTo({ top: entry.scrollTop });
      schedulePosition();
    } else {
      pendingScrollTop = entry.scrollTop;
      pendingAnchor = entry.anchor;
      loadFile(entry.path);
    }
  }
);
let pendingScrollTop = -1;
let pendingAnchor: ReadingAnchor | undefined;
const preview = useHoverPreview(() => body.value, (hash) => virtualReader?.preview(hash) || null);
watch([fontSize, fonts.fontFamily], () => {
  void nextTick(() => virtualReader?.invalidate());
});
function jump(id: string) {
  history.push();
  virtualReader?.jump(id);
  activeId.value = id;
  schedulePosition();
}
async function copyCode(button: HTMLElement) {
  const pre = button.parentElement?.querySelector("pre");
  const group = button.closest<HTMLElement>("[data-code-group]")?.dataset.codeGroup;
  const text = group !== undefined ? virtualReader?.code(Number(group)) || "" : pre?.textContent || "";
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    button.classList.add("copied");
    window.setTimeout(() => button.classList.remove("copied"), 1600);
  } catch {
    error.value = "复制失败：剪贴板不可用。";
  }
}
function clickDocument(event: MouseEvent) {
  const copy = (event.target as Element).closest<HTMLElement>(".code-copy");
  if (copy && body.value?.contains(copy)) {
    void copyCode(copy);
    return;
  }
  const link = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
  if (!link || !body.value?.contains(link)) return;
  event.preventDefault();
  preview.hide();
  const href = link.getAttribute("href") || "";
  if (href.startsWith("#")) {
    jump(href.slice(1));
    return;
  }
  if (isSafeExternal(href)) {
    void openUrl(href).catch((failure) => {
      if (!disposed) error.value = String(failure);
    });
    return;
  }
  const local = resolveLocalLink(currentFile.value, href);
  if (local && isMarkdownPath(local.path)) {
    history.push();
    loadFile(local.path, local.hash);
  } else
    error.value =
      "只打开 Markdown/文本文件；其他本地附件请使用系统文件管理器。";
}
function scrollDocument() {
  preview.dispose();
  schedulePosition();
}
function hoverDocument(event: MouseEvent) {
  const link = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
  if (!link || !body.value?.contains(link)) return;
  const href = link.getAttribute("href") || "";
  if (href.startsWith("#")) preview.schedule(link, href.slice(1));
}
function leaveDocument(event: MouseEvent) {
  const link = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
  if (link) preview.scheduleHide();
}
function keydown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) {
    readingKeys.reset(); return;
  }
  const mod = event.ctrlKey || event.metaKey;
  if (mod || event.altKey || isEditingTarget(event.target) || loading.value || !currentFile.value || fontPanelVisible.value) {
    readingKeys.reset();
  } else {
    const command = readingKeys.accept(event.key, event.repeat);
    if (command || event.key === "g") event.preventDefault();
    if (command === "search") { void showFind(true); return; }
    const area = readingArea.value;
    if (command && area) {
      preview.hide();
      if (command === "top" || command === "bottom") {
        history.push();
        virtualReader?.restore({ block: command === "top" ? 0 : virtualReader.model.blocks.length - 1, offset: 0 });
        area.scrollTop = command === "top" ? 0 : area.scrollHeight;
      } else virtualReader?.scrollBy(area.clientHeight * (command === "down" ? 0.5 : -0.5));
      schedulePosition(); return;
    }
  }
  const key = event.key.toLowerCase();
  if (mod && key === "s" && editing.value) {
    event.preventDefault(); void saveEditing(); return;
  }
  if (editing.value && key === "escape" && !findVisible.value) {
    event.preventDefault(); stopEditing(); return;
  }
  if (mod && event.shiftKey && key === "c" && currentFile.value && !isEditingTarget(event.target)) {
    event.preventDefault();
    void copyCurrentPath();
  } else if (mod && key === "o") {
    event.preventDefault();
    void chooseFile();
  } else if (mod && key === "f") {
    event.preventDefault();
    void showFind();
  } else if (mod && key === "w") {
    event.preventDefault();
    closeDocument();
  } else if (key === "escape") {
    fontPanelVisible.value = false;
    preview.hide();
    closeFind();
  } else if (event.altKey && key === "arrowleft") {
    event.preventDefault();
    history.back();
  } else if (event.altKey && key === "arrowright") {
    event.preventDefault();
    history.forward();
  } else if (mod && ["+", "=", "-", "0"].includes(key)) {
    event.preventDefault();
    if (key === "0") {
      fontSize.value = 17;
      savePreferences();
    } else changeFont(key === "-" ? -1 : 1);
  }
}
async function register(subscription: Promise<UnlistenFn>) {
  const unlisten = await subscription;
  if (disposed) unlisten();
  else cleanup.push(unlisten);
}
function mouseNav(event: MouseEvent) {
  if (event.button === 3) {
    event.preventDefault();
    history.back();
  } else if (event.button === 4) {
    event.preventDefault();
    history.forward();
  }
}
onMounted(async () => {
  startupReveal.start();
  window.addEventListener("keydown", keydown);
  window.addEventListener("blur", resetReadingKeys);
  window.addEventListener("focusin", resetReadingKeys);
  window.addEventListener("pointerdown", resetReadingKeys);
  window.addEventListener("resize", schedulePosition);
  window.addEventListener("mouseup", mouseNav);
  window.addEventListener("pagehide", flushPosition);
  document.addEventListener("visibilitychange", flushWhenHidden);
  try {
    const revision = interaction;
    // Register independent listeners in parallel; pending-open still waits for both.
    await Promise.all([
      register(
        listen<string>("md-reader://open-file", (event) =>
          loadFile(event.payload)
        )
      ),
      register(
        listen<{ paths: string[] }>(
          "tauri://drag-drop",
          (event) => {
            const path = event.payload.paths.find(isMarkdownPath);
            if (path) loadFile(path);
            else error.value = "请拖入 .md / .markdown / .mdx / .txt 文件。";
          },
          { target: { kind: "Webview", label: "main" } }
        )
      ),
    ]);
    // Always handshake after listeners attach, even if the user already interacted.
    if (disposed) return;
    const path = await invoke<string | null>("take_pending_open_file");
    if (!disposed && interaction === revision && path) loadFile(path);
  } catch (failure) {
    if (!disposed) error.value = `文件打开服务不可用：${String(failure)}`;
  } finally {
    if (!disposed && !loading.value)
      await nextTick(() => startupReveal.ready());
  }
});
onBeforeUnmount(() => {
  disposed = true;
  startupReveal.dispose();
  loader.dispose();
  find.clear();
  preview.dispose();
  for (const unlisten of cleanup) unlisten();
  window.removeEventListener("keydown", keydown);
  window.removeEventListener("blur", resetReadingKeys);
  window.removeEventListener("focusin", resetReadingKeys);
  window.removeEventListener("pointerdown", resetReadingKeys);
  window.removeEventListener("resize", schedulePosition);
  window.removeEventListener("mouseup", mouseNav);
  window.removeEventListener("pagehide", flushPosition);
  document.removeEventListener("visibilitychange", flushWhenHidden);
  clearDocument();
});
</script>

<template>
  <div class="reader-shell">
    <header class="toolbar">
      <div class="brand">
        <span class="brand-symbol"><ReaderIcon name="book" :size="24" /></span>
        <div><strong>MD Reader</strong><small>让阅读，回归简单</small></div>
      </div>
      <div class="toolbar-actions">
        <button
          class="filled-button"
          type="button"
          title="打开文件 (Ctrl+O)"
          @click="chooseFile"
        >
          <ReaderIcon name="folder" /><span>打开</span>
        </button>
        <button
          class="tonal-button"
          type="button"
          title="显示/隐藏目录"
          :aria-pressed="tocVisible"
          aria-controls="document-outline"
          @click="tocVisible = !tocVisible"
        >
          <ReaderIcon name="list" /><span>目录</span>
        </button>
        <button
          class="icon-button"
          type="button"
          title="文内查找 (Ctrl+F)"
          aria-label="打开文内查找"
          @click="showFind()"
        >
          <ReaderIcon name="search" />
        </button>
      </div>
      <span class="file-name" :title="currentFile">{{ fileName }}</span>
      <button
        v-if="currentFile"
        class="icon-button"
        type="button"
        :title="pathCopied ? '已复制' : '复制文件路径 (Ctrl+Shift+C)'"
        :aria-label="pathCopied ? '已复制文件路径' : '复制文件路径'"
        @click="copyCurrentPath"
      >
        <ReaderIcon :name="pathCopied ? 'check' : 'copy'" />
      </button>
      <div class="reading-tools">
        <button v-if="currentFile && !editing" class="tonal-button" type="button"
          title="编辑当前文件" @click="startEditing">编辑</button>
        <template v-if="editing">
          <span v-if="dirty" class="edit-dirty" aria-label="未保存的修改">未保存</span>
          <button class="filled-button" type="button" :disabled="saving"
            title="保存到原文件 (Ctrl+S)" @click="saveEditing">{{ saving ? "保存中…" : "保存" }}</button>
          <button class="tonal-button" type="button" :disabled="saving"
            @click="stopEditing">返回阅读</button>
        </template>
        <button
          class="icon-button"
          type="button"
          title="返回跳转前位置 (Alt+←)"
          aria-label="返回跳转前位置"
          :disabled="!history.canBack.value"
          @click="history.back()"
        >
          <ReaderIcon name="back" />
        </button>
        <button
          class="icon-button"
          type="button"
          title="前进 (Alt+→)"
          aria-label="前进"
          :disabled="!history.canForward.value"
          @click="history.forward()"
        >
          <ReaderIcon name="forward" />
        </button>
        <div class="font-control">
          <button
            type="button"
            title="减小字号"
            aria-label="减小字号"
            :disabled="fontSize <= 12"
            @click="changeFont(-1)"
          >
            A−
          </button
          ><span title="当前字号">{{ fontSize }}</span
          ><button
            type="button"
            title="增大字号"
            aria-label="增大字号"
            :disabled="fontSize >= 28"
            @click="changeFont(1)"
          >
            A+
          </button>
        </div>
        <button
          class="icon-button"
          type="button"
          title="自定义阅读字体"
          aria-label="自定义阅读字体"
          :aria-pressed="fontPanelVisible"
          @click="toggleFontPanel"
        >
          <ReaderIcon name="type" />
        </button>
        <button
          class="icon-button"
          type="button"
          :aria-pressed="dark"
          title="切换明暗主题"
          aria-label="切换明暗主题"
          @click="
            dark = !dark;
            savePreferences();
          "
        >
          <ReaderIcon :name="dark ? 'sun' : 'moon'" />
        </button>
        <button
          class="icon-button"
          type="button"
          title="关闭文档 (Ctrl+W)"
          aria-label="关闭文档"
          :disabled="!currentFile && !loading"
          @click="closeDocument"
        >
          <ReaderIcon name="close" />
        </button>
      </div>
    </header>
    <form
      v-if="findVisible"
      class="find-bar"
      role="search"
      @submit.prevent="find.move(1)"
    >
      <label for="find-input">{{ find.regex.value ? "正则查找" : "文内查找" }}</label>
      <input
        id="find-input"
        ref="findInput"
        v-model="query"
        maxlength="256"
        autocomplete="off"
        :placeholder="find.regex.value ? '输入正则表达式' : '输入文字'"
        :aria-invalid="!!find.searchError.value"
        @input="find.schedule"
        @keydown.enter="onFindEnter"
      />
      <output aria-live="polite">{{ find.busy.value ? "搜索中…" : findCount }}</output>
      <small v-if="find.searchError.value" role="alert">{{ find.searchError.value }}</small>
      <button type="button" aria-label="上一个匹配" @click="find.move(-1)">
        ↑
      </button>
      <button type="button" aria-label="下一个匹配" @click="find.move(1)">
        ↓
      </button>
      <button type="button" aria-label="关闭查找" @click="closeFind">
        关闭
      </button>
      <small v-if="findLimited">仅保留前 1000 个匹配，请缩小关键词范围。</small>
    </form>
    <section
      v-if="fontPanelVisible"
      class="font-panel"
      aria-label="自定义阅读字体"
    >
      <div class="font-panel-head">
        <strong>阅读字体</strong>
        <small
        >按顺序作为候选字体（最多 {{ fonts.maxCandidates }} 个）；缺字时回退到下一候选</small
        >
        <button
          type="button"
          class="icon-button"
          aria-label="关闭字体设置"
          @click="fontPanelVisible = false"
        >
          <ReaderIcon name="close" />
        </button>
      </div>
      <div v-if="fonts.families.value.length" class="font-selected">
        <span
          v-for="(name, index) in fonts.families.value"
          :key="name"
          class="font-chip"
          :style="{ fontFamily: quoteFamily(name) }"
        >
          <em>{{ index + 1 }}</em>{{ name }}
          <button
            type="button"
            :disabled="index === 0"
            aria-label="提高优先级"
            @click="fonts.move(name, -1)"
          >
            ←
          </button>
          <button
            type="button"
            :disabled="index === fonts.families.value.length - 1"
            aria-label="降低优先级"
            @click="fonts.move(name, 1)"
          >
            →
          </button>
          <button
            type="button"
            aria-label="移除该字体"
            @click="fonts.toggle(name)"
          >
            ×
          </button>
        </span>
        <button type="button" class="font-reset" @click="fonts.reset()">
          恢复默认
        </button>
      </div>
      <p v-else class="font-empty">未选择自定义字体，使用默认字体栈。</p>
      <input
        v-model="fontQuery"
        type="search"
        placeholder="搜索系统字体…"
        aria-label="搜索系统字体"
        autocomplete="off"
      />
      <p v-if="fonts.fontsError.value" class="font-empty" role="alert">
        {{ fonts.fontsError.value }}
      </p>
      <p v-else-if="fonts.fontsLoading.value" class="font-empty" role="status">
        正在读取系统字体…
      </p>
      <ul v-else class="font-list">
        <li v-for="name in filteredFonts" :key="name">
          <button
            type="button"
            :class="{ active: fonts.families.value.includes(name) }"
            :style="{ fontFamily: quoteFamily(name) }"
            @click="fonts.toggle(name)"
          >
            <span class="font-name">{{ name }}</span>
            <span class="font-sample" aria-hidden="true">永字八法 AaBb 123</span>
          </button>
        </li>
      </ul>
    </section>
    <div v-if="error" class="error" role="alert">
      {{ error }} <button type="button" @click="error = ''">知道了</button>
    </div>
    <div class="workspace">
      <DocumentOutline
        v-if="!editing && tocVisible && headings.length"
        id="document-outline"
        :headings="headings"
        :active-id="activeId"
        @jump="jump"
      />
      <main
        ref="readingArea"
        class="reading-area"
        tabindex="-1"
        aria-label="文档阅读区：gg 顶端，G 底端，d 下滑，e 上滑，/ 正则查找"
        :aria-busy="loading"
        @scroll.passive="scrollDocument"
        @load.capture="schedulePosition"
      >
        <div v-if="loading" class="empty" role="status">
          <span class="loading-ring" aria-hidden="true"></span>
          <h2>正在展开你的文档…</h2>
          <p>留一点时间，给下一次发现。</p>
        </div>
        <div v-else-if="!currentFile" class="empty">
          <div class="empty-mark"><ReaderIcon name="book" :size="52" /></div>
          <span class="eyebrow">YOUR QUIET READING SPACE</span>
          <h1>专注阅读 Markdown</h1>
          <p>
            少一点干扰，多一点沉浸。<br />打开或拖入一份文档，即刻开始阅读。
          </p>
          <button class="filled-button" type="button" @click="chooseFile">
            <ReaderIcon name="folder" />打开文档<span class="shortcut"
            >Ctrl O</span
            >
          </button>
          <div class="empty-features">
            <span>本地只读</span><span>多级目录</span><span>明暗主题</span>
          </div>
          <small>UTF-8 · 最大 8 MiB · 不编辑、不扫描目录</small>
        </div>
        <div v-if="editing" class="editor-pane">
          <label for="markdown-editor">Markdown 源码 · {{ fileName }}</label>
          <textarea id="markdown-editor" ref="editor" v-model="editSource" :disabled="saving"
            spellcheck="false" aria-label="Markdown 编辑器"></textarea>
          <small>Ctrl+S 保存到原文件 · Esc 返回阅读 · 最大 8 MiB</small>
        </div>
        <div v-if="currentFile && !editing" class="document-meta">
          <span class="eyebrow">MARKDOWN DOCUMENT</span
          ><span class="readonly-chip">只读 · 安心阅读</span>
        </div>
        <!-- This subtree belongs to the sanitized DOM renderer, not a v-html/source cache. -->
        <article
          ref="body"
          class="markdown-body"
          :hidden="editing"
          :style="{
            fontSize: `${fontSize}px`,
            fontFamily: fonts.fontFamily.value || undefined,
          }"
          @click="clickDocument"
          @mouseover="hoverDocument"
          @mouseout="leaveDocument"
        ></article>
      </main>
    </div>
    <div
      v-if="preview.visible.value"
      class="hover-preview"
      :style="{
        left: `${preview.position.value.x}px`,
        top: `${preview.position.value.y}px`,
        fontSize: `${Math.max(12, fontSize - 3)}px`,
      }"
      @mouseenter="preview.holdOpen()"
      @mouseleave="preview.scheduleHide()"
    >
      <PreviewContent :node="preview.content.value" />
    </div>
    <footer class="status-bar">
      <span class="status-dot" aria-hidden="true"></span
      ><span>{{
        loading ? "正在读取" : editing ? (dirty ? "编辑模式 · 未保存" : "编辑模式") : currentFile ? (virtualized ? "虚拟阅读 · Ctrl F 全文查找" : "本地文档 · 只读模式") : "准备就绪"
      }}</span
      ><span class="status-hint" title="gg 顶端 · G 底端 · d/e 下滑/上滑半屏 · / 正则查找 · Esc 退出查找">{{ currentFile ? "gg / G 首尾 · d / e 滚动 · / 正则" : "Ctrl O 打开 · Ctrl F 查找" }}</span
      ><span v-if="currentFile" class="reading-progress"
      >{{ progress }}%<span class="progress-track" aria-hidden="true"
      ><span :style="{ width: `${progress}%` }"></span></span
      ></span>
    </footer>
  </div>
</template>
