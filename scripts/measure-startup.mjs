// Run after copying the pre-change production build: node scripts/measure-startup.mjs <before-dist> <after-dist>
// These are browser navigation/paint measurements, NOT native process/WebView startup timings.
import { URL } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";

const roots = process.argv.slice(2).map((p) => resolve(p));
if (roots.length !== 2)
  throw new Error(
    "Usage: node scripts/measure-startup.mjs <before-dist> <after-dist>"
  );
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
};
let root = roots[0];
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(
      new URL(req.url, "http://localhost").pathname
    );
    const file = resolve(
      root,
      "." + (pathname === "/" ? "/index.html" : pathname)
    );
    if (!file.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Type",
      mime[extname(file)] || "application/octet-stream"
    );
    // Keep the production CSP script restriction; bootstrap must not require unsafe-inline.
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; frame-src 'none'; base-uri 'none'"
    );
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}`;
let browser;
const rows = [];
try {
  browser = await chromium.launch({ channel: "msedge", headless: true });
  for (const scenario of ["local", "delayed"]) {
    for (let sample = 0; sample < 5; sample++) {
      // Alternate builds to reduce sequential warm-up/order bias.
      for (const version of sample % 2 ? [1, 0] : [0, 1]) {
        root = roots[version];
        const context = await browser.newContext({
          viewport: { width: 1100, height: 760 },
          colorScheme: "dark",
        });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        const delayed = scenario === "delayed";
        await page.route("**/*.js", async (route) => {
          const name = new URL(route.request().url()).pathname;
          const delay = delayed
            ? /\/index-[^/]+\.js$/.test(name)
              ? 350
              : /\/document-[^/]+\.js$/.test(name)
                ? 200
                : 0
            : 0;
          if (delay) await new Promise((r) => setTimeout(r, delay));
          await route.continue();
        });
        await page.addInitScript(
          ({ delayed }) => {
            const timings = {};
            window.startupMeasurements = timings;
            const observer = new window.MutationObserver(() => {
              if (!timings.mounted && document.querySelector(".toolbar"))
                timings.mounted = window.performance.now();
              if (
                !timings.document &&
                document.querySelector(".markdown-body h1")
              ) {
                timings.document = window.performance.now();
                observer.disconnect();
              }
            });
            observer.observe(document, { subtree: true, childList: true });
            let id = 0;
            const sleep = (ms) =>
              new Promise((r) => setTimeout(r, delayed ? ms : 0));
            window.__TAURI_INTERNALS__ = {
              transformCallback: () => ++id,
              unregisterCallback() {},
              convertFileSrc: (p) => p,
              async invoke(command) {
                if (command === "reveal_main_window") return;
                if (command === "plugin:event|listen") {
                  await sleep(40);
                  return ++id;
                }
                if (command === "plugin:event|unlisten") return;
                if (command === "take_pending_open_file") {
                  await sleep(20);
                  return "C:/bench/sample.md";
                }
                if (command === "read_document") {
                  timings.readStarted = window.performance.now();
                  await sleep(100);
                  return {
                    path: "C:/bench/sample.md",
                    source:
                      "# Startup\n\nA focused Markdown reader.\n\n## Details\n\n" +
                      "A paragraph for reading.\n\n".repeat(50),
                  };
                }
                throw new Error(command);
              },
            };
          },
          { delayed }
        );
        await page.goto(url);
        await page.locator(".markdown-body h1").waitFor();
        await page.evaluate(
          () =>
            new Promise((r) =>
              requestAnimationFrame(() => requestAnimationFrame(r))
            )
        );
        const timings = await page.evaluate(() => ({
          ...window.startupMeasurements,
          fcp:
            window.performance.getEntriesByName("first-contentful-paint")[0]
              ?.startTime ?? null,
        }));
        if (errors.length || !timings.fcp || !timings.document)
          throw new Error(JSON.stringify({ errors, timings }));
        rows.push({
          scenario,
          version: version ? "after" : "before",
          sample,
          ...timings,
        });
        await context.close();
      }
    }
  }
  const median = (values) =>
    values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const summary = [];
  for (const scenario of ["local", "delayed"])
    for (const version of ["before", "after"]) {
      const group = rows.filter(
        (row) => row.scenario === scenario && row.version === version
      );
      summary.push({
        scenario,
        version,
        samples: group.length,
        fcpMs: median(group.map((r) => r.fcp)),
        mountedMs: median(group.map((r) => r.mounted)),
        documentMs: median(group.map((r) => r.document)),
      });
    }
  await mkdir(".startup-benchmark", { recursive: true });
  await writeFile(
    ".startup-benchmark/results.json",
    JSON.stringify(
      {
        browser: browser.version(),
        viewport: "1100x760",
        delayModel:
          "entry JS 350ms; parser JS 200ms; listener IPC 40ms each; pending IPC 20ms; read IPC 100ms",
        summary,
        rows,
      },
      null,
      2
    )
  );
  console.log(JSON.stringify({ browser: browser.version(), summary }, null, 2));
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
}
