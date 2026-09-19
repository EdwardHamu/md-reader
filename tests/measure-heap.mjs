// Optional production-bundle benchmark. Requires installed Microsoft Edge.
// node tests/measure-heap.mjs <baseline-dist> <optimized-dist>
// Reports V8 heap after explicit GC, NOT WebView2 working set/private bytes.
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { URL } from "node:url";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

async function serve(root) {
  root = path.resolve(root);
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = path.resolve(
      root,
      `.${pathname === "/" ? "/index.html" : pathname}`
    );
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      if (!(await stat(file)).isFile()) throw new Error("not a file");
      const type =
        {
          ".js": "text/javascript",
          ".html": "text/html",
          ".css": "text/css",
          ".svg": "image/svg+xml",
        }[path.extname(file)] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": type });
      res.end(await readFile(file));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

const roots = process.argv.slice(2);
assert.equal(
  roots.length,
  2,
  "Pass baseline dist and optimized dist directories"
);
const browser = await chromium.launch({ channel: "msedge", headless: true });
const results = {
  browser: browser.version(),
  method:
    "Production bundles; mocked IPC; CDP HeapProfiler.collectGarbage + Runtime.getHeapUsage; 3 fresh contexts per case. NOT native process RAM.",
  samples: [],
};
try {
  for (const [index, root] of roots.entries()) {
    const { server, url } = await serve(root);
    try {
      for (const documentOpen of [false, true]) {
        for (let repetition = 0; repetition < 3; repetition++) {
          const context = await browser.newContext();
          const page = await context.newPage();
          const errors = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.addInitScript(
            ({ documentOpen }) => {
              let id = 0;
              const callbacks = new Map();
              const fixture = () =>
                "# Heap fixture\n\n" +
                "A paragraph with **bold text**, `inline code` and a [link](https://example.com/).\n\n".repeat(
                  2000
                );
              window.__TAURI_INTERNALS__ = {
                metadata: {
                  currentWindow: { label: "main" },
                  currentWebview: { label: "main" },
                },
                transformCallback(callback) {
                  callbacks.set(++id, callback);
                  return id;
                },
                unregisterCallback(callbackId) {
                  callbacks.delete(callbackId);
                },
                convertFileSrc(file) {
                  return `http://asset.localhost/${encodeURIComponent(file)}`;
                },
                async invoke(command, args = {}) {
                  if (command === "plugin:event|listen") return ++id;
                  if (command === "plugin:event|unlisten") return;
                  if (
                    ["initial_open_file", "take_pending_open_file"].includes(
                      command
                    )
                  )
                    return documentOpen ? "C:/docs/fixture.md" : null;
                  if (command === "take_pending_open_files") return [];
                  if (command === "read_document")
                    return { path: String(args.path), source: fixture() };
                  if (command === "plugin:fs|read_text_file")
                    return new globalThis.TextEncoder().encode(fixture())
                      .buffer;
                  if (command === "plugin:fs|exists") return true;
                  if (command === "plugin:store|load") return 1;
                  if (command === "plugin:store|get") return null;
                  if (command === "check_pandoc")
                    return { installed: false, path: null };
                  if (command === "check_pdf_engine") return null;
                  if (command === "list_md_files") return [];
                  if (
                    /^(plugin:store\||plugin:window\||set_window_theme|start_watch|stop_watch)/.test(
                      command
                    )
                  )
                    return null;
                  console.warn("Unmodeled IPC", command);
                  return null;
                },
              };
            },
            { documentOpen }
          );
          await page.goto(url, { waitUntil: "networkidle" });
          await page.locator("#app > *").first().waitFor();
          if (documentOpen) {
            await page
              .locator(".markdown-body h1")
              .filter({ hasText: "Heap fixture" })
              .waitFor();
            assert.equal(await page.locator(".markdown-body p").count(), 2000);
          }
          assert.deepEqual(
            errors,
            [],
            "Page must be functional before heap comparison"
          );
          const cdp = await context.newCDPSession(page);
          await cdp.send("HeapProfiler.collectGarbage");
          const heap = await cdp.send("Runtime.getHeapUsage");
          const counters = await cdp.send("Memory.getDOMCounters");
          results.samples.push({
            version: index === 0 ? "baseline" : "minimal",
            documentOpen,
            repetition,
            ...heap,
            ...counters,
          });
          await context.close();
        }
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
