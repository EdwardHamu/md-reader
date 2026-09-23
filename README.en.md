# MD Reader · Minimal read-only edition

A single-document Markdown reader built with Tauri 2 and Vue 3, reduced to prioritize low memory usage. This workspace is **not the original full-featured editor**. The simplified interface is currently Chinese.

[中文](README.md)

## Included

Open/drop/OS-associated Markdown files, a heading outline, in-document find, relative document links, local/remote images, GFM tables, read-only tasks, footnotes, basic highlighting, light/dark themes and font size. Single-instance handling and window geometry restoration remain.

Reading positions for the 100 most recently opened files are remembered across restarts. Only file paths and block offsets are stored; files are not reopened automatically.

Basic highlighting covers JavaScript, TypeScript, JSON, Bash, Python, CSS, HTML/XML and Rust. Other languages and Mermaid fences remain readable code. Math is not rendered. YAML front matter is escaped text; MDX does not execute JSX.

## Removed

Editing/saving, tabs, a recent-files list and automatic session restoration, file tree, recursive scanning/watchers, cross-file search, all exports/printing/PDF preview, KaTeX, Mermaid, emoji shortcodes, update checks, font enumeration and advanced settings. Existing user settings/files are not deleted.

## Resource boundaries

- Current DOM only; no retained source/HTML history, background worker or multi-document cache.
- Markdown/highlighting loaded on first open; theme/font changes do not re-parse documents.
- One in-flight read plus the latest pending path; stale results are discarded.
- UTF-8 files up to **8 MiB**; up to 60,000 lines, 60,000 tokens allocated during parsing, 60,000 HTML markers (including closing tags), 60,000 display nodes, 3,000 headings and 12 Mi characters of rendered HTML. Limits produce explicit errors, not silent truncation.
- Token allocations are guarded during parsing, and HTML markers are bounded before DOM construction. Bare URLs are not auto-detected: use `[title](https://example.com)` or `<https://example.com>` syntax.
- Code blocks over 20,000 characters remain plain text.
- Find keeps at most 1,000 Ranges, debounces 150 ms and does not insert wrapper nodes. Matches are within individual text nodes. Older WebViews without CSS Highlights fall back to selecting the current result.
- Switching/closing releases find Ranges, outline metadata and the old DOM. Garbage collection and operating-system memory return are not instantaneous.
- DOMPurify and CSP protect rendered HTML; no Markdown write/export commands.

Images use native lazy loading, **not a hard decoded-image memory budget**. Large or previously viewed images can still be expensive. WebView2 has its own baseline cost; bundle size is not process RAM.

## Development

Node.js 22.6+, pnpm, Rust and platform-specific [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) are required.

```bash
pnpm install --frozen-lockfile --config.fetch-retries=3
pnpm test
pnpm lint
pnpm build
CARGO_NET_RETRY=3 cargo test --manifest-path src-tauri/Cargo.toml
pnpm test:e2e
pnpm tauri dev
```

Browser tests use installed Microsoft Edge and mock Tauri IPC; they do not prove native drag/drop, file associations or macOS/Linux integration. Change the channel in `playwright.config.ts` for other platforms. Tests and development dependencies are not shipped in the application.

Keyboard shortcuts: Ctrl/Cmd+O to open, +F to find, +W to close the document; Enter/Shift+Enter to navigate matches, Escape to close find; Ctrl/Cmd with +, − or 0 adjusts/resets the font size.

See the [audit and verification report](docs/mcp-md-reader-minimal-memory.md) for measured results and limitations.

## License

[MIT](LICENSE). Original author/project attribution: Neilooo/md-reader. Release scripts are retained; this change does not publish a release.
