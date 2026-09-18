import type MarkdownIt from "markdown-it";
import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs";

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Scans for the 2-char closing delimiter ("\\)" / "\\]") after `pos`.
// Backslash handling mirrors LaTeX: "\\" is an escaped backslash, "\\x" an
// escaped/command char, and only the literal close sequence ends the math —
// so a bare ")" inside "f(x)" does not close "\\(...\\)".
function findDelimEnd(
  src: string,
  pos: number,
  max: number,
  close: string
): number {
  while (pos < max) {
    if (src.startsWith(close, pos)) return pos;
    if (src.charCodeAt(pos) === 0x5c) {
      pos += 2;
      continue;
    }
    pos++;
  }
  return -1;
}

export default function mathPlugin(mdInstance: MarkdownIt): void {
  // \( ... \) inline and \[ ... \] display math. MUST run before the escape
  // rule: \( and \[ are valid CommonMark backslash escapes and would otherwise
  // be unescaped to plain "(" / "[" before the math rule ever sees them (#34).
  mdInstance.inline.ruler.before("escape", "math_paren", (state, silent) => {
    const start = state.pos;
    const max = state.posMax;
    if (state.src.charCodeAt(start) !== 0x5c) return false;
    const openChar = state.src.charCodeAt(start + 1);
    if (openChar !== 0x28 && openChar !== 0x5b) return false;
    const display = openChar === 0x5b;
    const close = display ? "\\]" : "\\)";
    const end = findDelimEnd(state.src, start + 2, max, close);
    if (end < 0) return false;
    const content = state.src.slice(start + 2, end);
    if (!content || /^\s+$/.test(content)) return false;
    if (!silent) {
      const token = state.push(
        display ? "math_block" : "math_inline",
        "math",
        0
      );
      token.markup = display ? "\\[" : "\\(";
      token.content = content;
    }
    state.pos = end + 2;
    return true;
  });

  mdInstance.inline.ruler.after("escape", "math_inline", (state, silent) => {
    const start = state.pos;
    if (state.src.charCodeAt(start) !== 0x24) return false;
    if (state.src.charCodeAt(start + 1) === 0x24) return false;
    const max = state.posMax;
    let pos = start + 1;
    while (pos < max) {
      const ch = state.src.charCodeAt(pos);
      if (ch === 0x5c) {
        pos += 2;
        continue;
      }
      if (ch === 0x24) break;
      pos++;
    }
    if (pos >= max) return false;
    const content = state.src.slice(start + 1, pos);
    if (!content || /^\s+$/.test(content)) return false;
    if (!silent) {
      const token = state.push("math_inline", "math", 0);
      token.markup = "$";
      token.content = content;
    }
    state.pos = pos + 1;
    return true;
  });

  const blockMathRule =
    (open: string, close: string, markup: string) =>
    (
      state: StateBlock,
      startLine: number,
      endLine: number,
      silent: boolean
    ): boolean => {
      const startPos = state.bMarks[startLine] + state.tShift[startLine];
      const maxPos = state.eMarks[startLine];
      if (startPos + open.length > maxPos) return false;
      if (state.src.slice(startPos, startPos + open.length) !== open)
        return false;
      let nextLine = startLine;
      let found = false;
      let content = "";
      const firstLineRest = state.src
        .slice(startPos + open.length, maxPos)
        .trim();
      if (
        firstLineRest.endsWith(close) &&
        firstLineRest.length >= close.length
      ) {
        content = firstLineRest.slice(0, -close.length);
        found = true;
      } else {
        if (firstLineRest) content = firstLineRest + "\n";
        for (nextLine = startLine + 1; nextLine < endLine; nextLine++) {
          const lineStart = state.bMarks[nextLine] + state.tShift[nextLine];
          const lineEnd = state.eMarks[nextLine];
          const line = state.src.slice(lineStart, lineEnd);
          if (line.trimEnd().endsWith(close)) {
            content += line.trimEnd().slice(0, -close.length);
            found = true;
            break;
          }
          content += line + "\n";
        }
      }
      if (!found) return false;
      if (silent) return true;
      const token = state.push("math_block", "math", 0);
      token.block = true;
      token.markup = markup;
      token.content = content;
      token.map = [startLine, nextLine + 1];
      state.line = nextLine + 1;
      return true;
    };

  mdInstance.block.ruler.after(
    "blockquote",
    "math_block",
    blockMathRule("$$", "$$", "$$"),
    { alt: [] }
  );
  mdInstance.block.ruler.after(
    "math_block",
    "math_bracket",
    blockMathRule("\\[", "\\]", "\\["),
    { alt: [] }
  );

  mdInstance.renderer.rules.math_inline = (tokens, idx) =>
    `<span class="math-inline" data-math="${escapeAttr(
      tokens[idx].content
    )}"></span>`;
  mdInstance.renderer.rules.math_block = (tokens, idx) => {
    // \[...\] delivered from an inline context renders as a span so it stays
    // valid HTML inside a <p>; block-level occurrences keep the div.
    const tag = tokens[idx].markup === "$$" ? "div" : "span";
    return `<${tag} class="math-block" data-math="${escapeAttr(
      tokens[idx].content
    )}"></${tag}>`;
  };
}
