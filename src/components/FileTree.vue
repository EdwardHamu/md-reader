<!--
  文件树递归组件：数据来自 useFileTree 的 TreeNode[]，
  组件引用自身渲染子目录。目录折叠状态按目录 path 记录在本地
  （组件递归实例各自持有，刷新后折叠状态重置）。
-->
<script setup lang="ts">
import { ref } from "vue";
import type { TreeNode } from "../composables/useFileTree";

defineProps<{
  nodes: TreeNode[];
  /** 当前打开文件路径，用于高亮对应树节点。 */
  currentPath: string;
  /** 递归深度（根调用不传），控制缩进。 */
  depth?: number;
}>();

const emit = defineEmits<{
  (e: "open", path: string): void;
}>();

/** 目录 path → 是否折叠。 */
const collapsed = ref<Record<string, boolean>>({});

function toggle(key: string) {
  collapsed.value[key] = !collapsed.value[key];
}
</script>

<template>
  <ul class="tree" :class="{ root: !depth }">
    <li v-for="node in nodes" :key="node.path || node.name" class="tree-item">
      <!-- 目录行：点击切换折叠，未折叠时递归渲染子级 -->
      <template v-if="node.isDir">
        <div
          class="row dir"
          :style="{ paddingLeft: (depth || 0) * 12 + 8 + 'px' }"
          @click="toggle(node.path)"
        >
          <span class="caret">
            {{ collapsed[node.path] ? "▶" : "▼" }}
          </span>
          <span class="name">{{ node.name }}</span>
        </div>
        <FileTree
          v-if="!collapsed[node.path] && node.children"
          :nodes="node.children"
          :current-path="currentPath"
          :depth="(depth || 0) + 1"
          @open="(p) => emit('open', p)"
        />
      </template>
      <!-- 文件行：点击打开（交给 App.vue 的 loadFile） -->
      <template v-else>
        <div
          class="row file"
          :class="{ active: currentPath === node.path }"
          :style="{ paddingLeft: (depth || 0) * 12 + 22 + 'px' }"
          :title="node.path"
          @click="emit('open', node.path)"
        >
          <span class="name">{{ node.name }}</span>
        </div>
      </template>
    </li>
  </ul>
</template>

<style scoped>
.tree {
  list-style: none;
  margin: 0;
  padding: 0;
  font-size: 13px;
}
.tree.root {
  padding: 4px 0;
}
.row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px 3px 8px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--tree-row-color);
  user-select: none;
}
.row:hover {
  background: var(--tree-row-hover-bg);
}
.row.active {
  background: var(--tree-row-active-bg);
  color: var(--tree-row-active-color);
  box-shadow: var(--tree-row-active-shadow);
}
.caret {
  font-size: 10px;
  color: var(--tree-caret-color);
  width: 12px;
  display: inline-block;
}
.dir .name {
  font-weight: 500;
  color: var(--tree-dir-color);
}
.file .name {
  color: var(--tree-file-color);
}
.row.active .name {
  color: var(--tree-row-active-color);
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
