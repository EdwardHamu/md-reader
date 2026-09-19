import DOMPurify from "dompurify";
import { convertFileSrc } from "@tauri-apps/api/core";
import { renderMarkdown } from "./markdown";
import { isSafeExternal, resolveLocalLink } from "./paths";

export interface Heading {
  id: string;
  text: string;
  level: number;
}

export function buildDocument(
  source: string,
  path: string
): { fragment: DocumentFragment; headings: Heading[] } {
  const fragment = DOMPurify.sanitize(renderMarkdown(source), {
    RETURN_DOM_FRAGMENT: true,
    USE_PROFILES: { html: true },
    FORBID_TAGS: [
      "style",
      "form",
      "iframe",
      "video",
      "audio",
      "source",
      "button",
      "textarea",
      "select",
    ],
    FORBID_ATTR: [
      "style",
      "srcset",
      "autofocus",
      "contenteditable",
      "formaction",
      "target",
    ],
  });
  // Bound live DOM before mounting; never leave a partly truncated document on screen.
  const walker = document.createTreeWalker(
    fragment,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT
  );
  let count = 0;
  while (walker.nextNode()) {
    if (++count > 60_000)
      throw new Error("文档超过 60000 个显示节点，请拆分后阅读。");
  }
  for (const input of fragment.querySelectorAll("input")) {
    if (input.type !== "checkbox") input.remove();
    else input.disabled = true;
  }
  for (const image of fragment.querySelectorAll<HTMLImageElement>("img")) {
    image.loading = "lazy";
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    const src = image.getAttribute("src") || "";
    if (/^https?:\/\//i.test(src)) continue;
    if (src.startsWith("//")) {
      image.src = `https:${src}`;
      continue;
    }
    // Inline raster images are bounded by the document limit; SVG/blob/other schemes are blocked.
    if (/^data:image\/(png|jpeg|gif|webp|avif);base64,/i.test(src)) continue;
    const local = src && resolveLocalLink(path, src);
    if (local) image.src = convertFileSrc(local.path);
    else image.removeAttribute("src");
  }
  for (const link of fragment.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    let href = link.getAttribute("href") || "";
    if (href.startsWith("//")) {
      href = `https:${href}`;
      link.setAttribute("href", href);
    }
    link.removeAttribute("download");
    link.rel = "noreferrer noopener";
    if (
      !href.startsWith("#") &&
      !isSafeExternal(href) &&
      !resolveLocalLink(path, href)
    )
      link.removeAttribute("href");
  }
  for (const table of fragment.querySelectorAll("table")) {
    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    table.replaceWith(wrap);
    wrap.append(table);
  }
  const headings: Heading[] = [];
  const used = new Set(
    Array.from(fragment.querySelectorAll("[id]"), (node) => node.id)
  );
  for (const heading of fragment.querySelectorAll<HTMLHeadingElement>(
    "h1,h2,h3,h4,h5,h6"
  )) {
    if (headings.length >= 3000)
      throw new Error("目录超过 3000 个标题，请拆分后阅读。");
    if (!heading.id) {
      let id = `reader-heading-${headings.length}`;
      while (used.has(id)) id += "-";
      heading.id = id;
      used.add(id);
    }
    headings.push({
      id: heading.id,
      text: (heading.textContent || "").slice(0, 300),
      level: Number(heading.tagName[1]),
    });
  }
  return { fragment, headings };
}
