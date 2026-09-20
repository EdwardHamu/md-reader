import test from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../src/reader/markdown.ts";
import { createLatestLoader } from "../src/reader/latest.ts";
import {
  fileUrl,
  resolveLocalLink,
  isSafeExternal,
  isMarkdownPath,
} from "../src/reader/paths.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
test("paths: Unicode, escaped fragments, Windows drives, UNC and POSIX", () => {
  assert.equal(
    fileUrl("C:\\文 档\\a#b.md"),
    "file:///C:/%E6%96%87%20%E6%A1%A3/a%23b.md"
  );
  assert.deepEqual(
    resolveLocalLink("C:/docs/readme.md", "../中文%20文档.md#标题"),
    { path: "C:/中文 文档.md", hash: "%E6%A0%87%E9%A2%98" }
  );
  assert.deepEqual(
    resolveLocalLink("//server/share/docs/a.md", "../img/a.png"),
    { path: "//server/share/img/a.png", hash: "" }
  );
  assert.deepEqual(resolveLocalLink("/home/me/docs/a.md", "../b.md"), {
    path: "/home/me/b.md",
    hash: "",
  });
  assert.equal(resolveLocalLink("C:/docs/a.md", "javascript:alert(1)"), null);
  assert.equal(
    resolveLocalLink("C:/docs/a.md", "https://example.com/a.md"),
    null
  );
  assert.equal(resolveLocalLink("C:/docs/a.md", "bad%ZZ.md"), null);
  assert.equal(isSafeExternal("file:///C:/evil.exe"), false);
  assert.equal(isSafeExternal("https://example.com"), true);
  assert.equal(isMarkdownPath("NOTES.MDX"), true);
  assert.equal(isMarkdownPath("x.exe"), false);
});
test("Markdown: headings, table, task list, footnotes and escaping", () => {
  const html = renderMarkdown(
    "# 标题\n\n# 标题\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n- [x] Done\n\nText[^a]\n\n[^a]: Note\n\n```unknown\n<script>alert(1)</script>\n```"
  );
  assert.match(html, /<table>/);
  assert.match(html, /id="%E6%A0%87%E9%A2%98-1"/);
  assert.match(html, /disabled/);
  assert.match(html, /footnote/);
  assert.match(html, /&lt;script&gt;/);
});
test("highlighting is bounded; unknown grammars and diagrams remain text", () => {
  assert.match(renderMarkdown("```js\nconst x = 1;\n```"), /hljs-keyword/);
  assert.doesNotMatch(
    renderMarkdown("```mermaid\ngraph TD; A-->B\n```"),
    /<svg|mermaid-block/
  );
  assert.doesNotMatch(
    renderMarkdown("```js\n" + "const x=1;\n".repeat(2500) + "```"),
    /hljs-keyword/
  );
  assert.match(renderMarkdown("---\na: <b>\n---\n\n# Hello"), /a: &lt;b&gt;/);
  assert.throws(() => renderMarkdown("x\n\n".repeat(21000)), /60000/);
  assert.throws(() => renderMarkdown("*a* ".repeat(30000)), /60000/);
  assert.throws(() => renderMarkdown("\n".repeat(60001)), /60000/);
  assert.throws(
    () => renderMarkdown("<div>" + "<i>x</i>".repeat(31000) + "</div>"),
    /60000/
  );
  // A thrown parse must restore the token array methods and the next document's budget.
  assert.match(renderMarkdown("# Recovered"), /Recovered/);
});
test("latest-only queue skips intermediate work and stale successes", async () => {
  const reads: string[] = [];
  const commits: string[] = [];
  let release!: (value: string) => void;
  const loader = createLatestLoader(
    async (path: string) => {
      reads.push(path);
      if (path === "old")
        return new Promise<string>((resolve) => {
          release = resolve;
        });
      return path;
    },
    (value) => {
      commits.push(value);
    },
    (error) => {
      throw error;
    },
    () => {}
  );
  loader.request("old");
  loader.request("middle");
  loader.request("latest");
  assert.deepEqual(reads, ["old"]);
  release("old content");
  await tick();
  assert.deepEqual(reads, ["old", "latest"]);
  assert.deepEqual(commits, ["latest"]);
});
test("cancel/dispose discard late reads and errors", async () => {
  let reject!: (reason: Error) => void;
  let commits = 0;
  let errors = 0;
  const loader = createLatestLoader(
    () =>
      new Promise<string>((_resolve, no) => {
        reject = no;
      }),
    () => {
      commits++;
    },
    () => {
      errors++;
    },
    () => {}
  );
  loader.request("a");
  loader.cancel();
  reject(new Error("late"));
  await tick();
  loader.request("b");
  loader.dispose();
  reject(new Error("disposed"));
  await tick();
  loader.request("ignored");
  assert.equal(commits, 0);
  assert.equal(errors, 0);
});
test("a failed current read reports once and a subsequent request still works", async () => {
  const errors: unknown[] = [];
  const committed: string[] = [];
  const loader = createLatestLoader(
    async (path: string) => {
      if (path === "bad") throw new Error("bad");
      return path;
    },
    (value) => {
      committed.push(value);
    },
    (error) => {
      errors.push(error);
    },
    () => {}
  );
  loader.request("bad");
  await tick();
  loader.request("good");
  await tick();
  assert.equal(errors.length, 1);
  assert.deepEqual(committed, ["good"]);
});

test("outline: skipped levels, collapse, depth and search context", async () => {
  const { buildOutline, filterOutline } =
    await import("../src/reader/outline.ts");
  const entries = buildOutline([
    { id: "a", text: "Overview", level: 1 },
    { id: "b", text: "配置", level: 3 },
    { id: "c", text: "详细参数", level: 6 },
    { id: "d", text: "Next", level: 2 },
    { id: "e", text: "End", level: 1 },
  ]);
  assert.deepEqual(
    entries.map((entry) => entry.depth),
    [0, 1, 2, 1, 0]
  );
  assert.deepEqual(
    entries.map((entry) => entry.children),
    [true, true, false, false, false]
  );
  assert.deepEqual(
    filterOutline(entries, 6, new Set(["b"]), "").map((e) => e.id),
    ["a", "b", "d", "e"]
  );
  assert.deepEqual(
    filterOutline(entries, 2, new Set(), "").map((e) => e.id),
    ["a", "d", "e"]
  );
  assert.deepEqual(
    filterOutline(entries, 1, new Set(["a"]), "参数").map((e) => e.id),
    ["a", "b", "c"]
  );
  assert.equal(filterOutline(entries, 6, new Set(), "不存在").length, 0);
  assert.equal(filterOutline(entries, 6, new Set(), "overview")[0].id, "a");
  assert.deepEqual(buildOutline([]), []);
});
