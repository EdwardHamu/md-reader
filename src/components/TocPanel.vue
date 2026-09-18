<!--
  目录（大纲）面板：由渲染后的标题列表构建可折叠树。
  activeId 来自 useScrollSpy 的滚动跟踪，用于高亮当前阅读位置；
  点击条目通过 jump 事件让 App.vue 滚动到对应标题。
-->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { Heading } from "../composables/useMarkdown";

const { t } = useI18n();

const props = defineProps<{
  headings: Heading[];
  activeId: string;
}>();

const emit = defineEmits<{
  (e: "jump", id: string): void;
}>();

/** 文档里出现的最高层级（比如从 h2 开始的文档），最浅一级不缩进。 */
const minLevel = computed(() =>
  props.headings.length
    ? Math.min(...props.headings.map((h) => h.level))
    : 1
);

/** 被折叠的标题索引集合（按索引而非 id 记录）。 */
const collapsed = ref<Set<number>>(new Set());

// 切换文档后标题集合变化，折叠状态整体重置
watch(
  () => props.headings,
  () => {
    collapsed.value = new Set();
  }
);

/**
 * 计算折叠后仍可见的标题索引：用栈维护祖先链——
 * 弹出所有层级不小于当前标题的栈顶（它们不是当前标题的祖先），
 * 若栈中存在被折叠的祖先则当前标题隐藏，否则可见。
 */
const visibleIndices = computed(() => {
  const result: number[] = [];
  const stack: { index: number; level: number }[] = [];
  for (let i = 0; i < props.headings.length; i++) {
    const h = props.headings[i];
    while (stack.length > 0 && stack[stack.length - 1].level >= h.level) {
      stack.pop();
    }
    if (!stack.some((s) => collapsed.value.has(s.index))) {
      result.push(i);
    }
    stack.push({ index: i, level: h.level });
  }
  return result;
});

/** 是否有下级标题（紧邻的下一个标题层级更深即视为有子节点）。 */
function hasChildren(index: number): boolean {
  return (
    index < props.headings.length - 1 &&
    props.headings[index + 1].level > props.headings[index].level
  );
}

/** 折叠/展开（替换整个 Set 以触发响应式更新）。 */
function toggleCollapse(index: number) {
  const next = new Set(collapsed.value);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  collapsed.value = next;
}

function expandAll() {
  collapsed.value = new Set();
}

/** 全部折叠：折叠所有"非顶级且有子节点"的标题。 */
function collapseAll() {
  const top = new Set<number>();
  for (let i = 0; i < props.headings.length; i++) {
    if (props.headings[i].level > minLevel.value && hasChildren(i)) {
      top.add(i);
    }
  }
  collapsed.value = top;
}
</script>

<template>
  <div class="toc">
    <div class="toc-title">
      <span>{{ t("toc.title") }}</span>
      <!-- 展开/折叠全部 -->
      <span v-if="headings.length" class="toc-actions">
        <button class="toc-action" @click="expandAll" :title="t('toc.expandAll')">
          ⊕
        </button>
        <button class="toc-action" @click="collapseAll" :title="t('toc.collapseAll')">
          ⊖
        </button>
      </span>
    </div>
    <div v-if="!headings.length" class="empty">{{ t("toc.empty") }}</div>
    <!-- 只渲染可见条目；缩进深度 = level - minLevel -->
    <ul v-else class="toc-list">
      <li
        v-for="idx in visibleIndices"
        :key="headings[idx].id + headings[idx].text"
        class="toc-item"
        :class="{ active: activeId === headings[idx].id }"
        :style="{ paddingLeft: (headings[idx].level - minLevel) * 12 + 4 + 'px' }"
        :title="headings[idx].text"
        @click="emit('jump', headings[idx].id)"
      >
        <span
          v-if="hasChildren(idx)"
          class="toc-toggle"
          @click.stop="toggleCollapse(idx)"
        >
          {{ collapsed.has(idx) ? "▶" : "▼" }}
        </span>
        <span v-else class="toc-toggle-spacer"></span>
        <span class="toc-text">{{ headings[idx].text }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.toc {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
  font-size: 13px;
}
.toc-title {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: var(--fg-muted);
  padding: 4px 12px 8px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 4px;
}
.toc-actions {
  margin-left: auto;
  display: flex;
  gap: 2px;
}
.toc-action {
  padding: 0 4px;
  font-size: 12px;
  line-height: 18px;
  color: var(--fg-muted);
  background: transparent;
  border: none;
  border-radius: 3px;
  cursor: pointer;
}
.toc-action:hover {
  color: var(--fg);
  background: var(--bg-btn-hover);
}
.toc-list {
  flex: 1 1 auto;
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  min-height: 0;
}
.toc-item {
  display: flex;
  align-items: center;
  padding: 3px 8px 3px 4px;
  cursor: pointer;
  color: var(--toc-item-color);
  border-left: 2px solid transparent;
  transition: color 0.12s, background-color 0.12s, box-shadow 0.12s;
}
.toc-item:hover {
  color: var(--toc-hover-color);
  background: var(--toc-hover-bg);
}
.toc-item.active {
  color: var(--toc-active-color);
  border-left-color: var(--toc-active-line);
  background: var(--toc-active-bg);
  box-shadow: var(--toc-active-shadow);
  font-weight: 600;
}
.toc-toggle {
  flex: 0 0 16px;
  text-align: center;
  cursor: pointer;
  user-select: none;
  font-size: 10px;
}
.toc-toggle-spacer {
  flex: 0 0 16px;
}
.toc-text {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.empty {
  padding: 8px 12px;
  color: var(--fg-muted);
  font-size: 12px;
}
</style>
