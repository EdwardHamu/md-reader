<!--
  页内查找条（悬浮在预览区右上角）：纯 UI 组件，搜索/高亮/跳转逻辑
  全在 useFindInPage；这里只收关键词并转发 next/prev/close 事件。
-->
<script setup lang="ts">
import { ref, watch, nextTick, onMounted } from "vue";
import { useI18n } from "vue-i18n";

const { t } = useI18n();

const props = defineProps<{
  visible: boolean;
  query: string;
  caseSensitive: boolean;
  total: number;
  activeIndex: number;
}>();

const emit = defineEmits<{
  (e: "update:query", v: string): void;
  (e: "update:caseSensitive", v: boolean): void;
  (e: "search"): void;
  (e: "next"): void;
  (e: "prev"): void;
  (e: "close"): void;
}>();

const inputRef = ref<HTMLInputElement | null>(null);

/** 每次输入立即重新搜索（高亮代价可接受，不做防抖）。 */
function onInput(evt: Event) {
  emit("update:query", (evt.target as HTMLInputElement).value);
  emit("search");
}

/** Enter/Shift+Enter 跳下一个/上一个，Esc 关闭。 */
function onKey(evt: KeyboardEvent) {
  if (evt.key === "Enter") {
    evt.preventDefault();
    if (evt.shiftKey) emit("prev");
    else emit("next");
  } else if (evt.key === "Escape") {
    evt.preventDefault();
    emit("close");
  }
}

/** 切换大小写敏感后需要立即重搜。 */
function toggleCase() {
  emit("update:caseSensitive", !props.caseSensitive);
  emit("search");
}

// 打开时聚焦并全选输入框，可直接覆盖上次关键词
watch(
  () => props.visible,
  async (v) => {
    if (v) {
      await nextTick();
      inputRef.value?.focus();
      inputRef.value?.select();
    }
  }
);

onMounted(() => {
  if (props.visible) inputRef.value?.focus();
});
</script>

<template>
  <div v-if="visible" class="find-bar">
    <input
      ref="inputRef"
      type="text"
      class="find-input"
      :placeholder="t('find.placeholder')"
      :value="query"
      @input="onInput"
      @keydown="onKey"
    />
    <span class="counter">
      {{ total === 0 ? "0/0" : `${activeIndex + 1}/${total}` }}
    </span>
    <button
      class="ic"
      :class="{ active: caseSensitive }"
      @click="toggleCase"
      :title="t('find.caseSensitive')"
    >
      Aa
    </button>
    <button class="ic" @click="emit('prev')" :title="t('find.previous') + ' (Shift+Enter)'">↑</button>
    <button class="ic" @click="emit('next')" :title="t('find.next') + ' (Enter)'">↓</button>
    <button class="ic" @click="emit('close')" :title="t('find.close') + ' (Esc)'">✕</button>
  </div>
</template>

<style scoped>
.find-bar {
  position: fixed;
  top: 84px;
  right: 24px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  background: var(--bg-toolbar);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 25;
}
.find-input {
  width: 200px;
  padding: 4px 8px;
  font-size: 13px;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 4px;
  outline: none;
}
.find-input:focus {
  border-color: var(--link);
}
.counter {
  font-size: 12px;
  color: var(--fg-muted);
  min-width: 44px;
  text-align: center;
}
.ic {
  font-size: 12px;
  padding: 3px 7px;
  background: transparent;
  color: var(--fg);
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
}
.ic:hover {
  background: var(--bg-btn-hover);
}
.ic.active {
  background: var(--bg-active);
  color: var(--link);
}
</style>
