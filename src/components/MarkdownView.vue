<!--
  预览渲染容器：把 Markdown 源码 v-html 进来，然后跑"渲染后处理管线"——
  1. rewriteImagesAndLinks：本地图片转 asset 协议、.md 链接改内部打开、表格包滚动层；
  2. renderMath / renderMermaid：公式与图表是异步替换 DOM 的，必须最后跑；
  3. 全部完成后 emit("rendered")，App.vue 借此做滚动位置恢复/大纲刷新。
  换主题时 Mermaid 图配色不会自动跟着变，父组件通过递增 renderTick
  触发 refreshThemeRender 强制重画 Mermaid。
-->
<script setup lang="ts">
import { ref, watch, onMounted, nextTick } from "vue";
import {
  renderMarkdown,
  renderMath,
  renderMermaid,
} from "../composables/useMarkdown";
import { rewriteImagesAndLinks } from "../composables/useLinkRewriter";

const props = defineProps<{
  source: string;
  currentFile: string;
  rootDir: string;
  renderTick?: number;
}>();
const emit = defineEmits<{
  (e: "rendered", el: HTMLElement): void;
  (e: "internal-link", path: string, hash: string): void;
}>();

const html = ref<string>("");
const root = ref<HTMLElement | null>(null);

/** 完整渲染管线（源码/文件/根目录任一变化都会触发）。 */
async function update() {
  html.value = renderMarkdown(props.source);
  await nextTick();
  if (root.value) {
    rewriteImagesAndLinks(
      root.value,
      { currentFile: props.currentFile, rootDir: props.rootDir },
      (path, hash) => emit("internal-link", path, hash)
    );
    await renderMath(root.value);
    await renderMermaid(root.value);
    emit("rendered", root.value);
  }
}

/** 仅重画 Mermaid（主题切换），其余内容不动、不重建 DOM。 */
async function refreshThemeRender() {
  if (!root.value) return;
  await renderMermaid(root.value, true);
  emit("rendered", root.value);
}

onMounted(() => update());
watch(
  () => [props.source, props.currentFile, props.rootDir],
  () => update()
);
watch(
  () => props.renderTick,
  () => refreshThemeRender()
);

// 暴露根元素给父组件（App.vue 用于查找/滚动定位）
defineExpose({ root });
</script>

<template>
  <article ref="root" class="markdown-body" v-html="html"></article>
</template>

<style scoped>
.markdown-body {
  padding: 32px 48px 80px;
  max-width: var(--reader-max-width, 900px);
  margin: 0 auto;
  line-height: var(--reader-line-height, 1.75);
  font-size: var(--reader-font-size, 16px);
  font-family: var(--reader-font-family, inherit);
  color: var(--fg);
}

:root[data-theme="dark"] .markdown-body {
  background: transparent;
  border: none;
  border-radius: 0;
  box-shadow: none;
}
</style>
