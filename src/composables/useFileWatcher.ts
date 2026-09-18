/**
 * 文件监听的前端壳：调后端 start_watch/stop_watch 命令，并订阅
 * `md-reader://file-changed` 事件（后端已做 300ms 防抖）。
 * 应用级单 watcher：同一时刻只监听一个根目录，start 会先 stop 旧的。
 * 变更如何分发到各标签见 App.vue 的 onFilesChanged。
 */

import { onUnmounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

export type FileChangeHandler = (paths: string[]) => void;

export function useFileWatcher() {
  // 当前监听的根目录（空串 = 未监听）
  const watching = ref<string>("");
  let unlisten: UnlistenFn | null = null;

  /** 切换监听目录：先停旧的，再启动新目录并挂事件监听。 */
  async function start(root: string, handler: FileChangeHandler) {
    await stop();
    await invoke("start_watch", { root });
    unlisten = await listen<string[]>("md-reader://file-changed", (event) => {
      handler(event.payload);
    });
    watching.value = root;
  }

  async function stop() {
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
    if (watching.value) {
      try {
        await invoke("stop_watch");
      } catch {
        /* ignore: 后端 watcher 已失效时静默 */
      }
      watching.value = "";
    }
  }

  onUnmounted(() => {
    void stop();
  });

  return { watching, start, stop };
}
