<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from "vue";
import ReaderIcon from "./ReaderIcon.vue";

const props = defineProps<{ files: string[]; current: string }>();
const emit = defineEmits<{ open: [path: string]; close: [] }>();
const query = ref("");
const input = shallowRef<HTMLInputElement | null>(null);

function fileName(path: string) {
  return path.replace(/\\/g, "/").split("/").pop() || path;
}
const filtered = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase();
  if (!needle) return props.files;
  return props.files.filter((path) => path.toLocaleLowerCase().includes(needle));
});
function openFirst() {
  const path = filtered.value[0];
  if (path) emit("open", path);
}
onMounted(() => input.value?.focus());
</script>

<template>
  <div class="recent-backdrop" @mousedown.self="emit('close')">
    <section class="recent-panel" role="dialog" aria-modal="true" aria-labelledby="recent-title">
      <header>
        <div>
          <h2 id="recent-title">最近打开</h2>
          <small>最多保留 100 个文件</small>
        </div>
        <button type="button" class="recent-close" aria-label="关闭最近文件" @click="emit('close')">×</button>
      </header>
      <label class="recent-search">
        <ReaderIcon name="search" :size="18" />
        <input ref="input" v-model="query" type="search" autocomplete="off"
          placeholder="输入文件名或路径快速过滤…" aria-label="过滤最近文件"
          @keydown.enter.prevent="openFirst" @keydown.esc.stop="emit('close')" />
      </label>
      <p class="recent-count">{{ filtered.length }} / {{ files.length }}</p>
      <ul v-if="filtered.length" class="recent-list">
        <li v-for="path in filtered" :key="path">
          <button type="button" :class="{ current: path === current }" :title="path" @click="emit('open', path)">
            <ReaderIcon name="history" :size="18" />
            <span><strong>{{ fileName(path) }}</strong><small>{{ path }}</small></span>
            <em v-if="path === current">当前</em>
          </button>
        </li>
      </ul>
      <div v-else class="recent-empty">
        <ReaderIcon name="history" :size="32" />
        <span>{{ files.length ? "没有匹配的文件" : "还没有打开过文件" }}</span>
      </div>
    </section>
  </div>
</template>

<style scoped>
.recent-backdrop { position: fixed; inset: 0; z-index: 80; display: grid; place-items: start center; padding: 72px 20px 20px; background: #0006; }
.recent-panel { width: min(680px, 100%); max-height: min(720px, calc(100vh - 92px)); display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--line); border-radius: 24px; background: var(--bg); color: var(--text); box-shadow: 0 18px 48px #0005; }
.recent-panel > header { display: flex; align-items: center; justify-content: space-between; padding: 20px 22px 12px; }
h2 { margin: 0; font-size: 20px; }
header small, .recent-count { color: var(--muted); }
.recent-close { width: 38px; min-height: 38px; padding: 0; font-size: 24px; }
.recent-search { display: flex; align-items: center; gap: 10px; margin: 0 22px; padding-left: 12px; border: 1px solid var(--line); border-radius: 14px; background: var(--panel); color: var(--muted); }
.recent-search:focus-within { outline: 3px solid var(--primary); outline-offset: 2px; }
.recent-search input { width: 100%; border: 0; outline: 0; background: transparent; }
.recent-count { margin: 8px 24px 4px; font-size: 12px; text-align: right; }
.recent-list { margin: 0; padding: 4px 10px 14px; overflow: auto; list-style: none; }
.recent-list button { width: 100%; min-height: 58px; justify-content: flex-start; padding: 8px 12px; border-radius: 12px; text-align: left; }
.recent-list button.current { background: var(--tonal); color: var(--on-tonal); }
.recent-list button > span { min-width: 0; flex: 1; display: grid; gap: 2px; }
.recent-list strong, .recent-list small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.recent-list small { color: var(--muted); font-size: 12px; }
.recent-list em { font-size: 11px; font-style: normal; }
.recent-empty { min-height: 180px; display: grid; place-items: center; align-content: center; gap: 12px; color: var(--muted); }
@media (max-width: 640px) { .recent-backdrop { padding: 56px 8px 8px; } .recent-panel { max-height: calc(100vh - 64px); border-radius: 18px; } }
</style>
