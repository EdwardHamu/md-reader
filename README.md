# MD Reader · 极简只读版

基于 Tauri 2 + Vue 3 的单文档 Markdown 阅读器。此工作区按“尽可能减少内存占用”的目标精简，**不是原版全功能编辑器**。

[English](README.en.md)

## 保留功能

- 打开、拖放和系统文件关联（`.md` / `.markdown` / `.mdx`；可手动打开 `.txt`）。
- 记住最近 100 个文件的阅读位置；再次打开（包括重启后）自动返回上次位置，不缓存文档内容。
- 标题目录、相对 Markdown 链接、页内锚点、系统浏览器打开 HTTP/HTTPS/mailto 链接。
- GFM 表格、只读任务列表、脚注、本地/网络图片；图片使用原生懒加载。
- 基础高亮：JavaScript、TypeScript、JSON、Bash、Python、CSS、HTML/XML、Rust；其他语言保留纯文本。
- 文内查找、简单明暗主题、字号调节。当前界面为中文。
- 单实例及窗口位置/尺寸恢复。

## 明确删除

编辑/保存、多个标签、最近文件列表与会话自动恢复、文件树/目录递归扫描/监听、跨文件搜索、所有导出、打印/PDF 预览、KaTeX、Mermaid、emoji 短码插件、检查更新、字体枚举和复杂设置。阅读位置记录仅保存文件路径和分块坐标，不自动打开上次阅读的文件。

公式不执行渲染，Mermaid 围栏按代码展示；YAML front matter 显示为转义文本，不再解析为对象。MDX 只按 Markdown 阅读，不执行 JSX。精简版不读写旧版本的文档缓存或偏好文件，也不主动删除它们。

## 低内存设计与边界

- 只保存当前文档 DOM，不保存源文/HTML 的响应式副本，不使用多标签文档缓存或常驻 worker。
- 首次打开文档才加载 Markdown/高亮模块；主题和字号变化不重新解析文档。
- 文件读取最多一项在途，等待队列仅保存最新一个路径，迟到的响应不挂载。
- UTF-8 文件最大 **8 MiB**，超限明确报错。最多 60000 行、解析过程中累计 60000 个语法节点、60000 个 HTML 标记（含闭合标记）、60000 个显示节点、3000 个标题，渲染 HTML 最大 12 Mi 字符；限制是防护边界，不是内存定额。
- 语法节点在解析过程中计数，HTML 标记在创建 DOM 前计数，避免完成巨大分配后才拒绝文档。裸 URL 不额外自动识别，请使用 `[标题](https://example.com)` 或 `<https://example.com>` 链接语法。
- 每段代码最多高亮 20000 字符；更长的代码仍完整显示为纯文本。
- 查找最多保存前 1000 个 Range，150 ms 防抖，不添加高亮包裹节点。匹配按单个文本节点进行，不跨行内格式节点；不支持 CSS Highlights 的旧 WebView 回退为当前结果选择。
- 关闭/切换文档立即释放搜索 Range、目录和旧 DOM 引用，实际归还内存的时机由 WebView/操作系统决定。
- HTML 经 DOMPurify 净化，阻止脚本/嵌入页面/文档内样式等主动内容；应用有 CSP，无 Markdown 写入或导出命令。

图片按需加载会减少首屏工作，但**并非图片解码内存的硬上限**；巨幅图片和已经滚动加载的图片仍可占用较多内存。WebView2 本身的进程开销仍存在，包体大小不等于运行内存。

## 快捷键

| 按键                  | 功能                   |
| --------------------- | ---------------------- |
| Ctrl/Cmd + O          | 打开文档               |
| Ctrl/Cmd + F          | 文内查找               |
| Enter / Shift + Enter | 查找下一个/上一个      |
| Esc                   | 关闭查找               |
| Ctrl/Cmd + W          | 关闭当前文档，保留应用 |
| Ctrl/Cmd + + / - / 0  | 增大/减小/重置字号     |

## 开发与验证

需要 Node.js 22.6+（Node 测试使用内建 TypeScript stripping）、pnpm、Rust 及对应平台的 [Tauri 依赖](https://v2.tauri.app/start/prerequisites/)。

```bash
pnpm install --frozen-lockfile --config.fetch-retries=3
pnpm test
pnpm lint
pnpm build
CARGO_NET_RETRY=3 cargo test --manifest-path src-tauri/Cargo.toml
pnpm test:e2e
pnpm tauri dev
```

浏览器测试默认使用本机 Microsoft Edge，无需下载独立 Chromium；它使用模拟 Tauri IPC，不替代原生拖放、文件关联、macOS/ Linux 验收。其他平台可修改 `playwright.config.ts` 的浏览器 channel。

本次调研、前后对比、验证结果及未验证项见 [内存优化记录](docs/mcp-md-reader-minimal-memory.md)。开发依赖和测试浏览器不打包到阅读器。

- 打包示例
```bash
bash scripts/release-win.sh --ref main --tag v0.3.10-win.3
```

## 许可

[MIT](LICENSE)。保留原项目 Neilooo/md-reader 的作者信息；原有发布脚本仍保留，本次不自动发布。
