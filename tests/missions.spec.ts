// E2E coverage for missions.md: outline follows the body; edit → read restores progress.
import { test, expect, type Page } from "@playwright/test";

async function setup(
  page: Page,
  source = "# First\n\nHello reader.\n\n## 中文标题\n\nText [next](second.md#second).\n\n```js\nconst answer = 42;\n```\n\n![test](img.png)\n"
) {
  await page.addInitScript(
    ({ source }) => {
      let id = 0;
      const callbacks = new Map<number, (event: unknown) => void>();
      const events = new Map<string, number>();
      const state = {
        reveals: [] as {
          dark: boolean;
          hasUI: boolean;
          hasDocument: boolean;
        }[],
        active: 0,
        peak: 0,
        reads: [] as string[],
        opened: [] as string[],
      };
      Object.assign(window, {
        testState: state,
        emitDrop: (paths: string[]) =>
          callbacks.get(events.get("tauri://drag-drop")!)?.({
            payload: { paths },
          }),
        emitOpen: (path: string) =>
          callbacks.get(events.get("md-reader://open-file")!)?.({
            payload: path,
          }),
        __TAURI_INTERNALS__: {
          metadata: {
            currentWindow: { label: "main" },
            currentWebview: { label: "main" },
          },
          transformCallback(callback: (event: unknown) => void) {
            callbacks.set(++id, callback);
            return id;
          },
          unregisterCallback(callbackId: number) {
            callbacks.delete(callbackId);
          },
          convertFileSrc(path: string) {
            return `http://asset.localhost/${encodeURIComponent(path)}`;
          },
          async invoke(command: string, args: Record<string, unknown> = {}) {
            if (command === "reveal_main_window") {
              state.reveals.push({
                dark: Boolean(args.dark),
                hasUI: !!document.querySelector(".reader-shell"),
                hasDocument: !!document.querySelector(".markdown-body h1"),
              });
              return;
            }
            if (command === "plugin:event|listen") {
              events.set(String(args.event), Number(args.handler));
              return ++id;
            }
            if (command === "plugin:event|unlisten") return;
            if (command === "save_document") { return; }
            if (command === "take_pending_open_file") return "C:/docs/first.md";
            if (command === "plugin:dialog|open") return "C:/docs/first.md";
            if (command === "plugin:opener|open_url") {
              state.opened.push(String(args.url));
              return;
            }
            if (command === "read_document") {
              const path = String(args.path);
              state.reads.push(path);
              state.active++;
              state.peak = Math.max(state.peak, state.active);
              await new Promise((resolve) =>
                setTimeout(resolve, path.includes("slow") ? 200 : 5)
              );
              state.active--;
              if (path.includes("missing")) throw new Error("file missing");
              return {
                path,
                source: path.endsWith("first.md")
                  ? source
                  : path.includes("many")
                    ? "# Many\n\n" + "match ".repeat(1500)
                    : `# ${path.split("/").pop()?.split(".")[0]}\n\nNew content.`,
              };
            }
            throw new Error(`Unexpected IPC: ${command}`);
          },
        },
      });
    },
    { source }
  );
  await page.route("http://asset.localhost/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
    })
  );
  await page.goto("/");
  await expect(page.locator(".markdown-body h1")).toBeVisible();
}

const longDoc = (headings: number) =>
  "# First\n\n" + Array.from({ length: headings }, (_, i) =>
    `## Section ${i}\n\n${"reading text ".repeat(40)}`).join("\n\n") + "\n";

async function tocActiveVisible(page: Page) {
  return page.evaluate(() => {
    const nav = document.querySelector<HTMLElement>(".toc-list");
    const active = document.querySelector<HTMLElement>(".toc a[aria-current='location']");
    if (!nav || !active) return "no-active";
    const n = nav.getBoundingClientRect(), a = active.getBoundingClientRect();
    return a.top >= n.top - 1 && a.bottom <= n.bottom + 1 ? "visible" : `hidden ${a.top} vs ${n.top}-${n.bottom}`;
  });
}

for (const count of [40, 160]) {
  test(`mission: outline follows body scrolling (${count} headings${count > 100 ? ", virtual TOC" : ""})`, async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 700 });
    await setup(page, longDoc(count));
    const area = page.locator(".reading-area");
    await area.evaluate((node) => { node.scrollTop = node.scrollHeight * 0.8; });
    await expect.poll(() => page.locator(".toc a[aria-current='location']").count()).toBe(1);
    await expect.poll(() => tocActiveVisible(page), { timeout: 4000 }).toBe("visible");
    await area.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await expect.poll(() => tocActiveVisible(page), { timeout: 4000 }).toBe("visible");
  });
}

test("mission: leaving edit mode restores the reading position and keeps saved progress", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 700 });
  await setup(page, longDoc(40));
  const area = page.locator(".reading-area");
  const position = () => area.evaluate((node) => node.scrollTop);
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem("reader-reading-progress-v1") || "[]")
    .find((e: { path: string }) => e.path === "C:/docs/first.md")?.anchor.block ?? -1);
  await area.evaluate((node) => { node.scrollTop = 3000; });
  await expect.poll(position).toBeGreaterThan(2500);
  await page.waitForTimeout(700); // progress flush debounce
  const before = await position();
  const blockBefore = await stored();
  expect(blockBefore).toBeGreaterThan(0);
  await page.getByTitle("编辑当前文件").click();
  await expect(page.locator("#markdown-editor")).toBeVisible();
  // Scroll while editing: this must not overwrite the saved progress.
  await area.evaluate((node) => { node.scrollTop = 0; });
  await page.waitForTimeout(800);
  expect(await stored()).toBe(blockBefore);
  await page.getByRole("button", { name: "返回阅读" }).click();
  await expect(page.locator("#markdown-editor")).toHaveCount(0);
  await expect.poll(async () => Math.abs((await position()) - before), { timeout: 4000 }).toBeLessThan(80);
  await expect.poll(() => tocActiveVisible(page), { timeout: 4000 }).toBe("visible");
});

test("mission: after saving, the reloaded document returns to the pre-edit position", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 700 });
  await setup(page, longDoc(40));
  const area = page.locator(".reading-area");
  const position = () => area.evaluate((node) => node.scrollTop);
  await area.evaluate((node) => { node.scrollTop = 3000; });
  await expect.poll(position).toBeGreaterThan(2500);
  const activeText = () => page.locator(".toc a[aria-current='location']").innerText().catch(() => "");
  await expect.poll(activeText).toContain("Section");
  const sectionBefore = await activeText();
  const reads = () => page.evaluate(() => (window as unknown as { testState: { reads: string[] } }).testState.reads.length);
  await page.getByTitle("编辑当前文件").click();
  await expect(page.locator("#markdown-editor")).toBeVisible();
  const readsBeforeSave = await reads();
  await area.evaluate((node) => { node.scrollTop = 0; });
  await page.locator("#markdown-editor").press("End");
  await page.locator("#markdown-editor").pressSequentially(" x");
  await page.getByTitle("保存到原文件 (Ctrl+S)").click();
  await expect(page.locator("#markdown-editor")).toHaveCount(0);
  // The saved file must actually be re-read and re-rendered.
  await expect.poll(reads).toBe(readsBeforeSave + 1);
  await expect(area).toHaveAttribute("aria-busy", "false");
  // Pixel offsets differ after a re-render (estimated heights); the reading section must match.
  await expect.poll(activeText, { timeout: 4000 }).toBe(sectionBefore);
  await expect.poll(position).toBeGreaterThan(2000);
});
