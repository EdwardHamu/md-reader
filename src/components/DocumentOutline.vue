<script setup lang="ts">
import { computed, ref, watch } from "vue";
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
    <nav class="toc-list" aria-label="章节导航">
      <div
        v-for="entry in visible"
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
