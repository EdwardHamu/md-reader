import { findRegex } from "./regex-search";
self.onmessage = (event: MessageEvent<{ blocks: { text: string; group?: number }[]; query: string }>) => {
  try { self.postMessage(findRegex(event.data.blocks, event.data.query)); }
  catch (error) { self.postMessage({ error: `正则表达式无效：${error instanceof Error ? error.message : String(error)}` }); }
};
