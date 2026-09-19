import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import anchor from "markdown-it-anchor";
import footnote from "markdown-it-footnote";
import taskLists from "markdown-it-task-lists";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import python from "highlight.js/lib/languages/python";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import rust from "highlight.js/lib/languages/rust";

for (const [name, language] of Object.entries({
  javascript,
  typescript,
  json,
  bash,
  python,
  css,
  xml,
  rust,
})) {
  hljs.registerLanguage(name, language);
}

const MAX_HIGHLIGHT_CHARS = 20_000;
const MAX_TOKENS = 60_000;
const MAX_HTML_CHARS = 12 * 1024 * 1024;
const md: MarkdownIt = new MarkdownIt({
  html: true,
  linkify: false, // Explicit Markdown/autolink syntax only; no whole-text URL match arrays.
  highlight(code, language) {
    // No automatic language detection and no grammar loading for unknown languages.
    if (
      code.length <= MAX_HIGHLIGHT_CHARS &&
      language &&
      hljs.getLanguage(language)
    ) {
      try {
        return hljs.highlight(code, { language, ignoreIllegals: true }).value;
      } catch {
        /* Readable plain text is preferable to a failed document. */
      }
    }
    return md.utils.escapeHtml(code);
  },
});
md.use(anchor, {
  slugify: (text: string) =>
    encodeURIComponent(text.trim().toLowerCase().replace(/\s+/g, "-")),
});
md.use(footnote);
md.use(taskLists, { enabled: false });

interface RenderBudget {
  tokenCount: number;
}

// Guard allocations while parsing, not just after creating a potentially huge token tree.
function budgetTokens(
  tokens: Token[],
  env: RenderBudget,
  parse: () => void
): void {
  const previous = Object.getOwnPropertyDescriptor(tokens, "push");
  Object.defineProperty(tokens, "push", {
    configurable: true,
    value: (...added: Token[]) => {
      env.tokenCount += added.length;
      if (env.tokenCount > MAX_TOKENS)
        throw new Error("解析超过 60000 个语法节点，请拆分后阅读。");
      return Array.prototype.push.apply(tokens, added);
    },
  });
  try {
    parse();
  } finally {
    if (previous) Object.defineProperty(tokens, "push", previous);
    else Reflect.deleteProperty(tokens, "push");
  }
}
const parseBlock = md.block.parse.bind(md.block);
const parseInline = md.inline.parse.bind(md.inline);
md.block.parse = (source, parser, env, tokens) =>
  budgetTokens(tokens, env, () => parseBlock(source, parser, env, tokens));
md.inline.parse = (source, parser, env, tokens) =>
  budgetTokens(tokens, env, () => parseInline(source, parser, env, tokens));

/** Raw HTML is intentionally NOT trusted: only mount through document.ts. */
export function renderMarkdown(source: string): string {
  // Preserve front matter as text without loading a YAML parser or interpreting tags.
  const normalized = source.replace(/^\uFEFF/, "");
  const matter = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.exec(
    normalized
  );
  const body = matter ? normalized.slice(matter[0].length) : normalized;
  // StateBlock creates line-index arrays before tokenization; bound those too.
  let lines = 1;
  for (
    let at = body.indexOf("\n");
    at !== -1;
    at = body.indexOf("\n", at + 1)
  ) {
    if (++lines > 60_000) throw new Error("文档超过 60000 行，请拆分后阅读。");
  }
  const env: RenderBudget = { tokenCount: 0 };
  const tokens = md.parse(body, env);
  let count = 0;
  const visit = (items: typeof tokens) => {
    for (const token of items) {
      if (++count > MAX_TOKENS)
        throw new Error(
          "文档结构过于复杂（超过 60000 个语法节点），请拆分后阅读。"
        );
      if (token.children) visit(token.children);
    }
  };
  visit(tokens);
  const html =
    (matter
      ? `<pre class="front-matter"><code>${md.utils.escapeHtml(matter[1])}</code></pre>`
      : "") + md.renderer.render(tokens, md.options, env);
  if (html.length > MAX_HTML_CHARS)
    throw new Error("渲染结果超过 12 Mi 字符，请拆分文档后阅读。");
  // Bound raw HTML tags before DOMPurify constructs a detached DOM (closing tags count too).
  let tags = 0;
  for (let at = html.indexOf("<"); at !== -1; at = html.indexOf("<", at + 1)) {
    if (++tags > 60_000)
      throw new Error("文档超过 60000 个 HTML 标记，请拆分后阅读。");
  }
  return html;
}
