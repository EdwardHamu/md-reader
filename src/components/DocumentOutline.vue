<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, onMounted, onBeforeUnmount, watch } from "vue";
import type { Heading } from "../reader/document";
import { buildOutline, filterOutline } from "../reader/outline";
import ReaderIcon from "./ReaderIcon.vue";
const props = defineProps<{ headings: Heading[]; activeId: string }>();
const emit = defineEmits<{ jump: [id: string] }>();
const query = ref("");
const maxLevel = ref(6);
const collapsed = ref(new Set<string>());
const entries = computed(() => buildOutline(props.headings));
const visible = computed(() =>
  filterOutline(entries.value, maxLevel.value, collapsed.value, query.value)
);
const nav = shallowRef<HTMLElement | null>(null);
const scrollTop = ref(0), viewport = ref(600);
const isVirtual = computed(() => visible.value.length > 100);
const rowHeight = 42;
const start = computed(() => isVirtual.value ? Math.max(0, Math.floor(scrollTop.value / rowHeight) - 8) : 0);
const end = computed(() => isVirtual.value ? Math.min(visible.value.length, Math.ceil((scrollTop.value + viewport.value) / rowHeight) + 8) : visible.value.length);
const rows = computed(() => visible.value.slice(start.value, end.value));
let observer: ResizeObserver | undefined;
// Follow the reading position, but never fight a reader who is scrolling the outline.
const FOLLOW_PAUSE_MS = 1500;
let manualUntil = 0;
function pauseFollow() { manualUntil = performance.now() + FOLLOW_PAUSE_MS; }
/** Index of the active heading, or of its nearest visible (e.g. collapsed) ancestor. */
function activeIndex(): number {
  const list = visible.value;
  const exact = list.findIndex((entry) => entry.id === props.activeId);
  if (exact >= 0 || !props.activeId) return exact;
  const entry = entries.value.find((item) => item.id === props.activeId);
  if (!entry) return -1;
  for (let i = entry.ancestors.length - 1; i >= 0; i--) {
    const at = list.findIndex((item) => item.id === entry.ancestors[i]);
    if (at >= 0) return at;
  }
  return -1;
}
async function revealActive(force = false) {
  if (!force && performance.now() < manualUntil) return;
  const el = nav.value;
  const index = activeIndex();
  if (!el || index < 0) return;
  if (isVirtual.value) {
    // Virtual rows may not be mounted: compute the offset from the fixed row height.
    const top = index * rowHeight;
    if (top < el.scrollTop || top + rowHeight > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, top - el.clientHeight / 3);
      scrollTop.value = el.scrollTop;
    }
    return;
  }
  await nextTick();
  const row = el.querySelectorAll<HTMLElement>(".toc-row")[index];
  if (!row) return;
  // Rect-based: independent of which ancestor is the offsetParent.
  const rowTop = row.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
  if (rowTop < el.scrollTop || rowTop + row.offsetHeight > el.scrollTop + el.clientHeight) {
    el.scrollTop = Math.max(0, rowTop - el.clientHeight / 3);
  }
}
onMounted(() => {
  observer = new ResizeObserver(() => { viewport.value = nav.value?.clientHeight || 600; });
  if (nav.value) observer.observe(nav.value);
  // Re-mounted (e.g. after leaving edit mode or re-showing the outline): jump to the current section.
  void nextTick(() => revealActive(true));
});
onBeforeUnmount(() => observer?.disconnect());
watch(visible, () => {
  scrollTop.value = 0;
  if (nav.value) nav.value.scrollTop = 0;
  void revealActive(true);
});
watch(() => props.activeId, () => void revealActive());
function onScroll() { scrollTop.value = nav.value?.scrollTop || 0; }
watch(
  () => props.headings,
  () => {
    query.value = "";
    collapsed.value = new Set();
  }
);
function toggle(id: string) {
  const next = new Set(collapsed.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsed.value = next;
}
function collapseAll() {
  collapsed.value = new Set(
    entries.value.filter((entry) => entry.children).map((entry) => entry.id)
  );
}
</script>

<template>
  <aside class="toc" aria-label="文档目录">
    <div class="toc-header">
      <span class="eyebrow">ON THIS PAGE</span>
      <h2>
        文档目录 <span class="count-chip">{{ headings.length }}</span>
      </h2>
    </div>
    <div class="toc-tools">
      <div class="toc-search">
        <ReaderIcon name="search" :size="17" /><input
          v-model="query"
          aria-label="筛选目录"
          placeholder="查找章节…"
          maxlength="100"
        /><button
          v-if="query"
          class="icon-button"
          aria-label="清空目录筛选"
          @click="query = ''"
        >
          <ReaderIcon name="close" :size="16" />
        </button>
      </div>
      <div class="toc-options">
        <label
        >显示至
          <select
            v-model.number="maxLevel"
            aria-label="目录标题层级"
            :disabled="!!query.trim()"
          >
            <option v-for="level in 6" :key="level" :value="level">
              {{ level === 6 ? "H6 · 全部" : `H${level}` }}
            </option>
          </select></label
        ><button
          class="text-button"
          :disabled="!!query.trim()"
          @click="collapsed = new Set()"
        >
          展开
        </button
        ><button
          class="text-button"
          :disabled="!!query.trim()"
          @click="collapseAll"
        >
          折叠
        </button>
      </div>
    </div>
    <nav ref="nav" class="toc-list" :class="{ 'toc-virtual': isVirtual }" aria-label="章节导航" @scroll.passive="onScroll" @wheel.passive="pauseFollow" @touchmove.passive="pauseFollow" @pointerdown="pauseFollow" @keydown="pauseFollow">
      <div v-if="isVirtual" aria-hidden="true" :style="{ height: `${start * rowHeight}px` }"></div>
      <div
        v-for="entry in rows"
        :key="entry.id"
        class="toc-row"
        :class="{ active: entry.id === activeId }"
        :style="{ '--depth': entry.depth }"
      >
        <button
          v-if="entry.children"
          class="toc-toggle"
          :aria-label="`${collapsed.has(entry.id) ? '展开' : '折叠'} ${entry.text || '无标题'}`"
          :aria-expanded="query.trim() ? true : !collapsed.has(entry.id)"
          :disabled="!!query.trim()"
          @click="toggle(entry.id)"
        >
          <ReaderIcon name="chevron" :size="14" />
        </button
        ><span v-else class="toc-leaf" aria-hidden="true">·</span>
        <a
          :href="`#${entry.id}`"
          :aria-current="entry.id === activeId ? 'location' : undefined"
          :title="entry.text"
          @click.prevent="emit('jump', entry.id)"
        ><span class="toc-level">H{{ entry.level }}</span
        ><span>{{ entry.text || "无标题" }}</span></a
        >
      </div>
      <div v-if="isVirtual" aria-hidden="true" :style="{ height: `${(visible.length - end) * rowHeight}px` }"></div>
      <p v-if="!visible.length" class="toc-empty">
        {{
          query.trim()
            ? "没有找到匹配章节，试试其他关键词。"
            : "此层级暂无标题，请选择更深层级。"
        }}
      </p>
    </nav>
    <div class="toc-footer">
      {{ visible.length }} / {{ headings.length }} 个标题<span
        v-if="query.trim()"
      >
        · 含上级章节</span
      ><span v-else> · 支持 H1–H6</span>
    </div>
  </aside>
</template>
