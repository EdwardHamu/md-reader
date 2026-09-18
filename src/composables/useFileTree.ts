/**
 * 文件树（模块级单例）：根目录选择/恢复 + 调后端 list_md_files 扫描 +
 * 把扁平相对路径列表组装成目录树。根目录持久化在 localStorage。
 */

import { ref, computed } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

/** 后端 MdFile（snake_case 与 Rust 端序列化一致）。 */
export interface MdFile {
  path: string;
  name: string;
  rel_path: string;
  size: number;
  modified_ms: number;
}

export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: TreeNode[];
  /** 仅文件节点：原始扫描数据。 */
  file?: MdFile;
}

const rootDir = ref<string>("");
const files = ref<MdFile[]>([]);
const loading = ref<boolean>(false);
const error = ref<string>("");

/**
 * 扁平文件列表 → 目录树：按 rel_path 逐级下钻，目录节点不存在则创建，
 * 每个节点始终插到父节点 children 尾部（最后统一排序）。
 */
function buildTree(items: MdFile[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", isDir: true, children: [] };
  for (const f of items) {
    const parts = f.rel_path.split(/[\\/]/);
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      if (isLast) {
        cur.children!.push({
          name: part,
          path: f.path,
          isDir: false,
          file: f,
        });
      } else {
        let next = cur.children!.find((c) => c.isDir && c.name === part);
        if (!next) {
          next = {
            name: part,
            path: parts.slice(0, i + 1).join("/"),
            isDir: true,
            children: [],
          };
          cur.children!.push(next);
        }
        cur = next;
      }
    }
  }
  sortNode(root);
  return root.children!;
}

/** 递归排序：目录在前，同级按中文 locale 比较文件名。 */
function sortNode(node: TreeNode): void {
  if (!node.children) return;
  node.children.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, "zh-CN");
  });
  node.children.forEach(sortNode);
}

const tree = computed<TreeNode[]>(() => buildTree(files.value));

/** 重新扫描根目录（打开目录/刷新/watcher 变更后调用）。 */
async function refresh(): Promise<void> {
  if (!rootDir.value) return;
  loading.value = true;
  error.value = "";
  try {
    const list = await invoke<MdFile[]>("list_md_files", {
      root: rootDir.value,
    });
    files.value = list;
  } catch (e: any) {
    error.value = String(e?.message ?? e);
  } finally {
    loading.value = false;
  }
}

/** 选择目录（对话框）并设为文件树根。 */
async function openFolder(): Promise<string | null> {
  const selected = await open({ multiple: false, directory: true });
  if (typeof selected === "string") {
    rootDir.value = selected;
    localStorage.setItem("md-reader-root", selected);
    await refresh();
    return selected;
  }
  return null;
}

/** 启动时恢复上次打开的根目录。 */
async function restoreRoot(): Promise<void> {
  const saved = localStorage.getItem("md-reader-root");
  if (saved) {
    rootDir.value = saved;
    await refresh();
  }
}

/** 关闭目录：清空树与持久化记录。 */
function clearRoot(): void {
  rootDir.value = "";
  files.value = [];
  localStorage.removeItem("md-reader-root");
}

export function useFileTree() {
  return {
    rootDir,
    files,
    tree,
    loading,
    error,
    refresh,
    openFolder,
    restoreRoot,
    clearRoot,
  };
}
