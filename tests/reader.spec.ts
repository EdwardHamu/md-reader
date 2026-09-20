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
const open = (page: Page, path: string) =>
  page.evaluate(
    (path) =>
      (window as unknown as { emitOpen: (path: string) => void }).emitOpen(
        path
      ),
    path
  );

test("opens, derives TOC, highlights, lazily loads images, navigates links and closes", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await setup(page);
  await expect(page.locator(".toc a")).toHaveCount(2);
  await expect(page.locator(".hljs-keyword")).toHaveText("const");
  await expect(page.locator(".markdown-body img")).toHaveAttribute(
    "loading",
    "lazy"
  );
  await expect(page.locator(".markdown-body img")).toHaveAttribute(
    "src",
    /asset\.localhost/
  );
  await page.getByRole("link", { name: "next", exact: true }).click();
  await expect(page.locator(".markdown-body h1")).toHaveText("second");
  await page.getByTitle("关闭文档 (Ctrl+W)").click();
  await expect(page.locator(".markdown-body")).toBeEmpty();
  await expect(page.locator(".toc")).toHaveCount(0);
  expect(errors).toEqual([]);
});
test("drop opens the first supported file and rejects other file types", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() =>
    (window as unknown as { emitDrop: (paths: string[]) => void }).emitDrop([
      "C:/docs/picture.png",
      "C:/docs/dropped.md",
    ])
  );
  await expect(page.locator(".markdown-body h1")).toHaveText("dropped");
  await page.evaluate(() =>
    (window as unknown as { emitDrop: (paths: string[]) => void }).emitDrop([
      "C:/docs/program.exe",
    ])
  );
  await expect(page.getByRole("alert")).toContainText("请拖入");
});
test("latest open wins; pending requests and document DOM do not accumulate", async ({
  page,
}) => {
  await setup(page);
  await open(page, "C:/docs/slow.md");
  await open(page, "C:/docs/ignored.md");
  await open(page, "C:/docs/latest.md");
  await expect(page.locator(".markdown-body h1")).toHaveText("latest");
  const state = await page.evaluate(
    () =>
      (window as unknown as { testState: { peak: number; reads: string[] } })
        .testState
  );
  expect(state.peak).toBe(1);
  expect(state.reads).not.toContain("C:/docs/ignored.md");
  for (let i = 0; i < 15; i++) {
    await open(page, `C:/docs/round${i}.md`);
    await expect(page.locator(".markdown-body h1")).toHaveText(`round${i}`);
  }
  await expect(page.locator(".markdown-body h1")).toHaveCount(1);
  await open(page, "C:/docs/slow.md");
  await page.getByTitle("关闭文档 (Ctrl+W)").click();
  await page.waitForTimeout(250);
  await expect(page.locator(".markdown-body")).toBeEmpty();
});
test("find caps Ranges without adding DOM and releases them on close/switch", async ({
  page,
}) => {
  await setup(page);
  await open(page, "C:/docs/many.md");
  await expect(page.locator(".markdown-body h1")).toHaveText("Many");
  const before = await page.locator(".markdown-body *").count();
  await page.getByTitle("文内查找 (Ctrl+F)").click();
  await page.getByLabel("文内查找", { exact: true }).fill("match");
  await expect(page.locator(".find-bar output")).toHaveText("1 / 1000+");
  expect(await page.locator(".markdown-body *").count()).toBe(before);
  await page.getByRole("button", { name: "下一个匹配" }).click();
  await expect(page.locator(".find-bar output")).toHaveText("2 / 1000+");
  await open(page, "C:/docs/second.md");
  await expect(page.locator(".markdown-body h1")).toHaveText("second");
  await expect(page.locator(".find-bar output")).toHaveText("0 / 0");
  expect(
    await page.evaluate(
      () =>
        (CSS as typeof CSS & { highlights: Map<string, unknown> }).highlights
          .size
    )
  ).toBe(0);
});
test("sanitizes hostile HTML, keeps inert formulas and rejects unsafe links", async ({
  page,
}) => {
  await setup(
    page,
    '# Safe\n\n<script>window.hacked=1</script><img src="x" onerror="window.hacked=1"><iframe src="https://example.com"></iframe><style>body{display:none}</style><a href="javascript:alert(1)">bad</a><a href="https://example.com/">web</a>\n\n```mermaid\ngraph TD; A-->B\n```\n\n$x^2$'
  );
  await expect(
    page.locator(
      ".markdown-body script, .markdown-body iframe, .markdown-body style, .markdown-body [onerror]"
    )
  ).toHaveCount(0);
  await expect(
    page.locator(".markdown-body a").filter({ hasText: "bad" })
  ).not.toHaveAttribute("href", /javascript/);
  await expect(page.locator(".markdown-body")).toContainText("graph TD; A-->B");
  await expect(page.locator(".markdown-body")).toContainText("$x^2$");
  await page.getByRole("link", { name: "web", exact: true }).click();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { testState: { opened: string[] } }).testState
          .opened
    )
  ).toEqual(["https://example.com/"]);
  expect(await page.evaluate(() => "hacked" in window)).toBe(false);
});
test("read failure is recoverable and preferences do not re-render document", async ({
  page,
}) => {
  await setup(page);
  await page.locator(".markdown-body h1").evaluate((node) => {
    node.setAttribute("data-test-identity", "original");
  });
  await page.getByTitle("增大字号").click();
  await page.getByTitle("切换明暗主题").click();
  await expect(page.locator(".markdown-body h1")).toHaveAttribute(
    "data-test-identity",
    "original"
  );
  await open(page, "C:/docs/missing.md");
  await expect(page.getByRole("alert")).toContainText("file missing");
  await open(page, "C:/docs/recovered.md");
  await expect(page.locator(".markdown-body h1")).toHaveText("recovered");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("fine outline supports H1–H6, collapse, filtering and active navigation", async ({
  page,
}) => {
  await setup(
    page,
    "# Root\n\nIntro\n\n## Chapter\n\nText\n\n### Detail\n\n#### Options\n\n##### Advanced\n\n###### Deep target\n\nEnd\n\n## Other\n\n" +
      "Paragraph.\n\n".repeat(30)
  );
  await expect(page.locator(".toc a")).toHaveCount(7);
  await page.getByLabel("目录标题层级").selectOption("3");
  await expect(page.locator(".toc a")).toHaveCount(4);
  await page.getByLabel("目录标题层级").selectOption("6");
  await page.getByRole("button", { name: "折叠 Chapter", exact: true }).click();
  await expect(page.locator(".toc a")).toHaveCount(3);
  await page.getByLabel("筛选目录").fill("Deep target");
  await expect(page.locator(".toc a")).toHaveCount(6);
  await expect(page.getByLabel("目录标题层级")).toBeDisabled();
  await page.locator(".toc a").filter({ hasText: "Deep target" }).click();
  await expect(page.locator(".toc a[aria-current='location']")).toContainText(
    "Deep target"
  );
  await page.getByLabel("筛选目录").fill("not present");
  await expect(page.locator(".toc-empty")).toContainText("没有找到");
  await page.getByRole("button", { name: "清空目录筛选" }).click();
  await page.getByRole("button", { name: "展开", exact: true }).click();
  await expect(page.locator(".toc a")).toHaveCount(7);
  await page.getByRole("button", { name: "折叠", exact: true }).click();
  await expect(page.locator(".toc a")).toHaveCount(1);
  await open(page, "C:/docs/second.md");
  await expect(page.locator(".toc a")).toHaveCount(1);
  await expect(page.locator(".toc a")).toContainText("second");
});

test("MD3 layouts support dark theme, narrow viewport and empty state", async ({
  page,
}) => {
  await setup(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTitle("打开文件 (Ctrl+O)")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true);
  await page.getByTitle("显示/隐藏目录").click();
  await expect(page.locator(".toc")).toHaveCount(0);
  await page.getByTitle("显示/隐藏目录").click();
  await expect(page.locator(".toc")).toBeVisible();
  await page.getByTitle("切换明暗主题").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: "test-results/md3-mobile-dark.png" });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByTitle("切换明暗主题").click();
  await page.screenshot({ path: "test-results/md3-reading-light.png" });
  await page.getByTitle("关闭文档 (Ctrl+W)").click();
  await expect(
    page.getByRole("heading", { name: "专注阅读 Markdown" })
  ).toBeVisible();
  await expect(page.locator(".markdown-body")).toBeEmpty();
  await page.screenshot({ path: "test-results/md3-empty-light.png" });
});

for (const [saved, system] of [
  ["dark", "light"],
  ["light", "dark"],
] as const) {
  test(`startup shell paints saved ${saved} theme before the application module`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: system });
    await page.addInitScript(
      (theme) => localStorage.setItem("reader-theme", theme),
      saved
    );
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/src/main.ts", async (route) => {
      await held;
      await route.continue();
    });
    const ready = setup(page);
    try {
      await expect(page.locator("#startup-shell")).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", saved);
      await expect(page.locator(".toolbar")).toHaveCount(0);
    } finally {
      release();
    }
    await ready;
    await expect(page.locator("#startup-shell")).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute("data-theme", saved);
  });
}

test("disk read starts while lazy parser is still downloading", async ({
  page,
}) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/src/reader/document.ts", async (route) => {
    await held;
    await route.continue();
  });
  const ready = setup(page);
  try {
    await expect(page.locator(".toolbar")).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { testState: { reads: string[] } }).testState
              .reads
        )
      )
      .toContain("C:/docs/first.md");
    await expect(page.locator(".markdown-body")).toBeEmpty();
  } finally {
    release();
  }
  await ready;
  await expect(page.locator(".markdown-body h1")).toHaveText("First");
});

test("startup survives blocked preferences and exposes recovery if application fails", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new Error("blocked");
    };
  });
  await page.route("**/src/main.ts", (route) => route.abort());
  await page.goto("/");
  await expect(page.locator("#startup-shell")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("link", { name: "重新加载" })).toBeVisible({
    timeout: 12000,
  });
});

test("native reveal is sent once after UI and initial document are ready", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("reader-theme", "dark"));
  await setup(page);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { testState: { reveals: unknown[] } }).testState
            .reveals.length
      )
    )
    .toBe(1);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { testState: { reveals: unknown[] } }).testState
          .reveals[0]
    )
  ).toEqual({ dark: true, hasUI: true, hasDocument: true });
  await open(page, "C:/docs/second.md");
  await expect(page.locator(".markdown-body h1")).toHaveText("second");
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { testState: { reveals: unknown[] } }).testState
          .reveals.length
    )
  ).toBe(1);
});

test("hidden-WebView rAF suspension and slow parser cannot keep the window hidden", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.requestAnimationFrame = () => 1;
    window.cancelAnimationFrame = () => {};
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/src/reader/document.ts", async (route) => {
    await held;
    await route.continue();
  });
  const ready = setup(page);
  try {
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { testState?: { reveals: unknown[] } })
              .testState?.reveals.length || 0
        )
      )
      .toBe(1);
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { testState: { reveals: unknown[] } }).testState
            .reveals[0]
      )
    ).toEqual({ dark: false, hasUI: true, hasDocument: false });
    await expect(page.locator(".reading-area")).toHaveAttribute(
      "aria-busy",
      "true"
    );
  } finally {
    release();
  }
  await ready;
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { testState: { reveals: unknown[] } }).testState
          .reveals.length
    )
  ).toBe(1);
});
