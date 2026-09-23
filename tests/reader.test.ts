import test from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, renderMarkdownChunks } from "../src/reader/markdown.ts";
import { createLatestLoader } from "../src/reader/latest.ts";
import { createReadingProgressStore } from "../src/reader/progress.ts";
import {
  fileUrl,
  resolveLocalLink,
  isSafeExternal,
  isMarkdownPath,
  splitBlockAnchor,
} from "../src/reader/paths.ts";



test("reading progress: keep the latest 100 file anchors across restarts", () => {
  const data = new Map<string, string>();
  let writes = 0;
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem(key: string, value: string) { writes++; data.set(key, value); },
  };
  const first = createReadingProgressStore(storage);
  for (let i = 0; i < 100; i++) {
    assert.equal(first.remember(`C:/docs/${i}.md`, { block: i, offset: i + 0.5 }), true);
  }
  assert.equal(writes, 0); // A scroll never needs a synchronous storage write.
  first.flush();
  assert.equal(writes, 1);
  const resumed = createReadingProgressStore(storage);
  assert.deepEqual(resumed.get("C:/docs/0.md"), { block: 0, offset: 0.5 });
  assert.equal(resumed.remember("C:/docs/0.md", { block: 0, offset: 0.5 }), true);
  assert.equal(resumed.remember("C:/docs/100.md", { block: 100, offset: 1.25 }), true);
  resumed.flush();
  const entries = JSON.parse(data.get("reader-reading-progress-v1")!) as { path: string }[];
  assert.equal(entries.length, 100);
  assert.equal(entries[0].path, "C:/docs/2.md");
  assert.equal(entries.at(-1)?.path, "C:/docs/100.md");
  assert.equal(resumed.get("C:/docs/1.md"), undefined);
  assert.deepEqual(createReadingProgressStore(storage).get("C:/docs/0.md"), { block: 0, offset: 0.5 });
  assert.equal(resumed.remember("C:/docs/100.md", { block: 100, offset: 1.25 }), false);
  resumed.flush();
  assert.equal(writes, 2);
});

test("reading progress: ignore invalid data and survive unavailable storage", () => {
  const malformed = createReadingProgressStore({
    getItem: () => JSON.stringify([
      { path: "invalid", anchor: { block: -1, offset: 0 } },
      { path: "nan", anchor: { block: 0, offset: "NaN" } },
      { path: "valid", anchor: { block: 1, offset: 3.5 } },
      { path: "valid", anchor: { block: 2, offset: 0 } },
    ]),
    setItem: () => {},
  });
  assert.equal(malformed.get("invalid"), undefined);
  assert.equal(malformed.get("nan"), undefined);
  assert.deepEqual(malformed.get("valid"), { block: 2, offset: 0 });
  const blocked = createReadingProgressStore({
    getItem: () => { throw new Error("denied"); },
    setItem: () => { throw new Error("quota"); },
  });
  assert.equal(blocked.remember("/home/docs/a.md", { block: 9, offset: 4 }), true);
  assert.doesNotThrow(() => blocked.flush());
  assert.deepEqual(blocked.get("/home/docs/a.md"), { block: 9, offset: 4 });
  assert.equal(createReadingProgressStore({ getItem: () => "{", setItem: () => {} }).get("x"), undefined);
});

test("reading keys: timed gg, repeats, cancellation and exact case", async () => {
  const { createReadingKeys } = await import("../src/reader/keyboard.ts");
  const keys = createReadingKeys();
  assert.equal(keys.accept("g", false, 0), undefined);
  assert.equal(keys.accept("g", true, 100), undefined);
  assert.equal(keys.accept("g", false, 200), "top");
  keys.accept("g", false, 1000);
  assert.equal(keys.accept("g", false, 1801), undefined);
  keys.reset();
  assert.equal(keys.accept("g", false, 1802), undefined);
  keys.accept("x");
  assert.equal(keys.accept("g", false, 1803), undefined);
  for (const [key, action] of [["G", "bottom"], ["d", "down"], ["e", "up"], ["/", "search"]]) {
    assert.equal(keys.accept(key), action);
  }
  assert.equal(keys.accept("D"), undefined);
});

test("regex: Unicode, slice boundaries, anchors, invalid and empty matches, cap", async () => {
  const { findRegex } = await import("../src/reader/regex-search.ts");
  assert.deepEqual(findRegex([{ text: "prefix 中文", group: 1 }, { text: "🙂 42", group: 1 }], "中文. \\d+").matches,
    [{ block: 0, start: 7, length: 7, endBlock: 1, end: 5 }]);
  assert.equal(findRegex([{ text: "one", group: 1 }, { text: "two", group: 2 }], "one.*two").matches.length, 0);
  assert.equal(findRegex([{ text: "Hello\nHELLO" }], "^hello$").matches.length, 2);
  assert.equal(findRegex([{ text: "🙂abc" }], "(?=.)|$").matches.length, 0);
  assert.equal(findRegex([{ text: "aaa" }], "a", 2).limited, true);
  assert.equal(findRegex([{ text: "aa" }], "a", 2).limited, false);
  assert.throws(() => findRegex([{ text: "text" }], "["), SyntaxError);
  assert.equal(findRegex([{ text: "text" }], "").matches.length, 0);
});
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

test("paths: Obsidian block anchors require a space and safe id charset", () => {
  assert.deepEqual(splitBlockAnchor("some text ^quote-1"), {
    text: "some text",
    id: "^quote-1",
  });
  assert.deepEqual(splitBlockAnchor("trailing  ^b2_x  "), {
    text: "trailing",
    id: "^b2_x",
  });
  assert.equal(splitBlockAnchor("power 2^10"), null);
  assert.equal(splitBlockAnchor("no anchor here"), null);
  assert.equal(splitBlockAnchor("bad ^中文id"), null);
  assert.equal(splitBlockAnchor("^lonely"), null);
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


test("height index agrees with a linear oracle after arbitrary measurements", async () => {
  const { HeightIndex } = await import("../src/reader/virtual-index.ts");
  const values = Array.from({ length: 10000 }, (_, i) => 12 + i % 91);
  const index = new HeightIndex(values);
  for (let i = 0; i < values.length; i += 37) { values[i] = 10 + i % 127; index.set(i, values[i]); }
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    assert.equal(index.prefix(i), sum);
    assert.equal(index.at(sum), i);
    assert.equal(index.at(sum + values[i] - 0.1), i);
    sum += values[i];
  }
  assert.equal(index.total, sum);
  assert.equal(index.at(sum + 1000), 9999);
  assert.deepEqual(new HeightIndex([]).window(0, 600, 600), { start: 0, end: 0 });
  const window = index.window(sum / 2, 700, 700);
  assert.ok(index.prefix(window.start) <= sum / 2 - 700);
  assert.ok(index.prefix(window.end) >= sum / 2 + 1400);
  assert.ok(window.end - window.start < 100);
});

test("indexed find includes offscreen Unicode text, literal patterns, inline joins and the cap", async () => {
  const { findText } = await import("../src/reader/virtual-index.ts");
  const blocks = Array.from({ length: 10000 }, (_, i) => ({ text: `段落 ${i} 中文🙂` }));
  blocks[9999].text = "远处 a+b 中文🙂";
  assert.deepEqual(findText(blocks, "a+b").matches, [{ block: 9999, start: 3, length: 3 }]);
  assert.equal(findText(blocks, "中文🙂").limited, true);
  assert.equal(findText(blocks, "中文🙂").matches.length, 1000);
  assert.equal(findText(blocks, "").matches.length, 0);
  assert.equal(findText([{ text: "İx" }], "x").matches[0].start, 1);
});

test("streamed Markdown preserves document-wide references and permits 18000-line documents", () => {
  const sample = "# Same\n\n[ref][r]\n\n# Same\n\nFoot[^n]\n\n[r]: https://example.com\n[^n]: text\n";
  assert.equal(Array.from(renderMarkdownChunks(sample)).join(""), renderMarkdown(sample));
  const long = "# Huge\n\n" + Array.from({ length: 3000 }, (_, i) =>
    `## Section ${i}\n\nLong paragraph ${"中文🙂 word ".repeat(8)}\n\nSecond paragraph.\n\n`).join("");
  const chunks = Array.from(renderMarkdownChunks(long));
  assert.ok(chunks.length > 9000);
  assert.ok(chunks.at(-1)?.includes("Second paragraph"));
  assert.throws(() => Array.from(renderMarkdownChunks("\n".repeat(200001))), /200000/);
});


test("find spans virtual slices of one block without crossing semantic boundaries", async () => {
  const { findText } = await import("../src/reader/virtual-index.ts");
  assert.deepEqual(findText([{ text: "prefix 中文", group: 1 }, { text: "🙂 suffix", group: 1 }], "中文🙂").matches,
    [{ block: 0, start: 7, length: 4, endBlock: 1, end: 2 }]);
  assert.equal(findText([{ text: "one", group: 1 }, { text: "two", group: 2 }], "onetwo").matches.length, 0);
  assert.equal(findText([{ text: "aa", group: 1 }, { text: "aa", group: 1 }, { text: "aa", group: 1 }], "aaa").matches.length, 2);
});
