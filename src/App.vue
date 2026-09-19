<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { createLatestLoader } from "./reader/latest";
import {
  isMarkdownPath,
  isSafeExternal,
  resolveLocalLink,
  scrollToHash,
} from "./reader/paths";
import { useFind } from "./reader/find";
import type { Heading } from "./reader/document";

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
const error = ref("");
const tocVisible = ref(true);
const findInput = shallowRef<HTMLInputElement | null>(null);
const find = useFind(body);
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
const dark = ref(
  saved("reader-theme") === "dark" ||
    (!saved("reader-theme") &&
      window.matchMedia("(prefers-color-scheme: dark)").matches)
);
const fontSize = ref(
  Math.max(12, Math.min(28, Number(saved("reader-font-size")) || 17))
);
function savePreferences() {
  document.documentElement.dataset.theme = dark.value ? "dark" : "light";
  try {
    localStorage.setItem("reader-theme", dark.value ? "dark" : "light");
    localStorage.setItem("reader-font-size", String(fontSize.value));
  } catch {
    /* Reading still works with unavailable preference storage. */
  }
}
savePreferences();
function changeFont(delta: number) {
  fontSize.value = Math.max(12, Math.min(28, fontSize.value + delta));
  savePreferences();
}
function clearDocument() {
  find.reset(); // Ranges must be released before detaching their DOM.
  headings.value = [];
  body.value?.replaceChildren();
  currentFile.value = "";
}
const loader = createLatestLoader(
  async (request: OpenRequest) => {
    // Parser/highlighting are absent from the startup chunk. No worker/second JS heap.
    const renderer = await import("./reader/document");
    const data = await invoke<DocumentData>("read_document", {
      path: request.path,
    });
    return { data, renderer };
  },
  ({ data, renderer }, request) => {
    if (!body.value) return;
    const result = renderer.buildDocument(data.source, data.path);
    body.value.replaceChildren(result.fragment);
    headings.value = result.headings;
    currentFile.value = data.path;
    if (body.value.parentElement) body.value.parentElement.scrollTop = 0;
    if (request.hash) scrollToHash(body.value, request.hash);
    // Source + HTML are not stored in refs, tab objects, a history or localStorage.
    document.title = `${data.path.replace(/\\/g, "/").split("/").pop()} — MD Reader`;
  },
  (failure) => {
    error.value = String(failure);
  },
  () => {
    loading.value = false;
  }
);
function loadFile(path: string, hash = "") {
  if (disposed) return;
  ++interaction;
  clearDocument();
  error.value = "";
  loading.value = true;
  document.title = "MD Reader";
  loader.request({ path, hash });
}
function closeDocument() {
  ++interaction;
  loader.cancel();
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
async function showFind() {
  findVisible.value = true;
  await nextTick();
  findInput.value?.focus();
  findInput.value?.select();
  if (query.value) find.search();
}
function jump(id: string) {
  if (body.value) scrollToHash(body.value, id);
}
function clickDocument(event: MouseEvent) {
  const link = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
  if (!link || !body.value?.contains(link)) return;
  event.preventDefault();
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
  if (local && isMarkdownPath(local.path)) loadFile(local.path, local.hash);
  else
    error.value =
      "只打开 Markdown/文本文件；其他本地附件请使用系统文件管理器。";
}
function keydown(event: KeyboardEvent) {
  const mod = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  if (mod && key === "o") {
    event.preventDefault();
    void chooseFile();
  } else if (mod && key === "f") {
    event.preventDefault();
    void showFind();
  } else if (mod && key === "w") {
    event.preventDefault();
    closeDocument();
  } else if (key === "escape") find.close();
  else if (mod && ["+", "=", "-", "0"].includes(key)) {
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
onMounted(async () => {
  window.addEventListener("keydown", keydown);
  try {
    await register(
      listen<string>("md-reader://open-file", (event) =>
        loadFile(event.payload)
      )
    );
    await register(
      // Only subscribe to drops, not drag-enter/over/leave or the whole Webview class.
      listen<{ paths: string[] }>(
        "tauri://drag-drop",
        (event) => {
          const path = event.payload.paths.find(isMarkdownPath);
          if (path) loadFile(path);
          else error.value = "请拖入 .md / .markdown / .mdx / .txt 文件。";
        },
        { target: { kind: "Webview", label: "main" } }
      )
    );
    if (disposed) return;
    const revision = interaction;
    const path = await invoke<string | null>("take_pending_open_file");
    if (!disposed && interaction === revision && path) loadFile(path);
  } catch (failure) {
    if (!disposed) error.value = `文件打开服务不可用：${String(failure)}`;
  }
});
onBeforeUnmount(() => {
  disposed = true;
  loader.dispose();
  find.clear();
  for (const unlisten of cleanup) unlisten();
  window.removeEventListener("keydown", keydown);
  clearDocument();
});
</script>

<template>
  <div class="reader-shell">
    <header class="toolbar">
      <strong class="brand">MD Reader <small>只读</small></strong>
      <button type="button" title="打开文件 (Ctrl+O)" @click="chooseFile">
        打开
      </button>
      <button
        type="button"
        title="显示/隐藏目录"
        :aria-pressed="tocVisible"
        @click="tocVisible = !tocVisible"
      >
        目录
      </button>
      <button type="button" title="文内查找 (Ctrl+F)" @click="showFind">
        查找
      </button>
      <span class="file-name" :title="currentFile">{{
        currentFile.replace(/\\/g, "/").split("/").pop() || "单文档阅读"
      }}</span>
      <button
        type="button"
        title="减小字号"
        aria-label="减小字号"
        @click="changeFont(-1)"
      >
        A−
      </button>
      <button
        type="button"
        title="增大字号"
        aria-label="增大字号"
        @click="changeFont(1)"
      >
        A+
      </button>
      <button
        type="button"
        :aria-pressed="dark"
        title="切换明暗主题"
        @click="
          dark = !dark;
          savePreferences();
        "
      >
        {{ dark ? "浅色" : "深色" }}
      </button>
      <button
        type="button"
        title="关闭文档 (Ctrl+W)"
        :disabled="!currentFile && !loading"
        @click="closeDocument"
      >
        关闭
      </button>
    </header>
    <form
      v-if="findVisible"
      class="find-bar"
      role="search"
      @submit.prevent="find.move(1)"
    >
      <label for="find-input">文内查找</label>
      <input
        id="find-input"
        ref="findInput"
        v-model="query"
        maxlength="256"
        autocomplete="off"
        placeholder="输入文字"
        @input="find.schedule"
        @keydown.enter.prevent="find.move($event.shiftKey ? -1 : 1)"
      />
      <output aria-live="polite">{{ findCount }}</output>
      <button type="button" aria-label="上一个匹配" @click="find.move(-1)">
        ↑
      </button>
      <button type="button" aria-label="下一个匹配" @click="find.move(1)">
        ↓
      </button>
      <button type="button" aria-label="关闭查找" @click="find.close">
        关闭
      </button>
      <small v-if="findLimited">仅保留前 1000 个匹配，请缩小关键词范围。</small>
    </form>
    <div v-if="error" class="error" role="alert">
      {{ error }} <button type="button" @click="error = ''">知道了</button>
    </div>
    <div class="workspace">
      <aside
        v-if="tocVisible && headings.length"
        class="toc"
        aria-label="文档目录"
      >
        <h2>
          文档目录 <small>{{ headings.length }}</small>
        </h2>
        <a
          v-for="heading in headings"
          :key="heading.id"
          :href="`#${heading.id}`"
          :style="{ paddingLeft: `${12 + (heading.level - 1) * 12}px` }"
          @click.prevent="jump(heading.id)"
        >{{ heading.text || "无标题" }}</a
        >
      </aside>
      <main class="reading-area" :aria-busy="loading">
        <div v-if="loading" class="empty" role="status">正在读取…</div>
        <div v-else-if="!currentFile" class="empty">
          <div class="empty-mark">M↓</div>
          <h1>专注阅读 Markdown</h1>
          <p>打开或拖入一份文档，即刻开始阅读。</p>
          <button type="button" @click="chooseFile">打开文档</button>
          <small>UTF-8 · 最大 8 MiB · 不编辑、不扫描目录</small>
        </div>
        <!-- This subtree belongs to the sanitized DOM renderer, not a v-html/source cache. -->
        <article
          ref="body"
          class="markdown-body"
          :style="{ fontSize: `${fontSize}px` }"
          @click="clickDocument"
        ></article>
      </main>
    </div>
  </div>
</template>
