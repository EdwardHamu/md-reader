/**
 * 全局搜索的后端命令封装：searchInFiles 调 Rust 端 search_in_files
 * （递归扫描 + 大小写可选匹配，上限默认 500 条）。
 */

import { invoke } from "@tauri-apps/api/core";

/** 命中条目（snake_case 与 Rust 端 SearchMatch 序列化一致）。 */
export interface SearchMatch {
  path: string;
  rel_path: string;
  line: number;
  column: number;
  preview: string;
}

export async function searchInFiles(
  root: string,
  query: string,
  caseSensitive: boolean,
  maxResults = 500
): Promise<SearchMatch[]> {
  if (!root || !query.trim()) return [];
  return await invoke<SearchMatch[]>("search_in_files", {
    root,
    query,
    caseSensitive,
    maxResults,
  });
}
