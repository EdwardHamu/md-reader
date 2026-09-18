/**
 * 导出前的资源内联：把 DOM 里的图片转成 dataURL，让导出的 HTML /
 * Edge 打印 / PNG 截图完全脱离源目录与网络。
 * - 本地图片：Tauri asset 协议 URL → 还原绝对路径 → plugin-fs 读取
 * - 远程图片：仅允许公网地址（内网/环回一律拒绝），fetch 后转 base64
 * - SVG 统一补 xmlns（Mermaid 产物序列化后可能缺失，Edge 解析会失败）
 */

import { readFile } from "@tauri-apps/plugin-fs";

// Tauri asset 协议的几种 URL 形态（asset:// 与 Windows 上的 https://asset.localhost/）
const TAURI_ASSET_PATTERNS = [
  /^https?:\/\/asset\.localhost\//i,
  /^asset:\/\/localhost\//i,
  /^https?:\/\/[^/]+\.localhost\/+/i,
];

/** 是否为不需要内联的外部协议（http/data/blob/mailto/tel）。 */
function isExternal(src: string): boolean {
  return /^(https?:|data:|blob:|mailto:|tel:)/i.test(src);
}

/** 从 asset URL 还原本地路径（含 URI 解码；匹配失败返回 null）。 */
function decodeTauriAsset(src: string): string | null {
  for (const re of TAURI_ASSET_PATTERNS) {
    if (re.test(src)) {
      const rest = src.replace(re, "");
      try {
        return decodeURIComponent(rest);
      } catch {
        return rest;
      }
    }
  }
  return null;
}

/** 从路径取小写扩展名（截掉 query/hash）。 */
function extFromPath(p: string): string {
  const m = p.match(/\.([A-Za-z0-9]+)(?:\?|#|$)/);
  return m ? m[1].toLowerCase() : "";
}

/** 扩展名 → MIME 类型映射（读本地文件时没有 content-type 可用）。 */
function mimeFromExt(ext: string): string {
  switch (ext) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "svg": return "image/svg+xml";
    case "webp": return "image/webp";
    case "bmp": return "image/bmp";
    default: return "application/octet-stream";
  }
}

/** Uint8Array → base64。分 32KB 块拼接，避免 String.fromCharCode 传参超限。 */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunk))
    );
  }
  return btoa(bin);
}

/**
 * SSRF 防护：判断 URL 是否指向内网/环回地址（localhost、.local/.internal、
 * 私有 IPv4 段、IPv6 环回/链路本地/ULA）。远程图片内联只允许公网地址。
 */
function isPrivateUrl(url: string): boolean {
  let u: InstanceType<typeof globalThis.URL>;
  try {
    u = new globalThis.URL(url);
  } catch {
    return true;
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  // IPv4-mapped IPv6 地址先还原成 IPv4 再判断
  const mapped = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  const ipv4Host = mapped ? mapped[1] : host;
  const v4 = ipv4Host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const octets = v4.slice(1).map((s) => Number.parseInt(s, 10));
    if (octets.some((n) => n > 255)) return true;
    const [first, second] = octets;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 100 && second >= 64 && second <= 127)
    );
  }
  // IPv6：全零/环回/链路本地(fe80)/ULA(fc,fd)
  if (host.includes(":")) {
    return (
      host === "::" ||
      host === "::1" ||
      host === "0:0:0:0:0:0:0:0" ||
      host === "0:0:0:0:0:0:0:1" ||
      host.startsWith("fe80:") ||
      host.startsWith("fc") ||
      host.startsWith("fd")
    );
  }
  return false;
}

/** 远程图片 → dataURL（内网地址直接拒绝；MIME 缺失时按扩展名推断）。 */
async function fetchAsDataUrl(url: string): Promise<string | null> {
  if (isPrivateUrl(url)) return null;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    const ct = r.headers.get("content-type") || mimeFromExt(extFromPath(url));
    return `data:${ct};base64,${bytesToBase64(buf)}`;
  } catch {
    return null;
  }
}

/** 本地文件 → dataURL（按扩展名推 MIME；失败返回 null 保持原 src）。 */
async function readLocalAsDataUrl(absPath: string): Promise<string | null> {
  try {
    const bytes = await readFile(absPath);
    const u8 =
      bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as any);
    const ext = extFromPath(absPath);
    return `data:${mimeFromExt(ext)};base64,${bytesToBase64(u8)}`;
  } catch {
    return null;
  }
}

/**
 * 把 root 下所有 img 的 src 替换为 dataURL：
 * asset 协议 → 读本地文件；http(s) → 公网 fetch；已是 data: 的跳过。
 * 失败的保持原样（导出时可能加载不出，但不阻塞整体流程）。
 */
export async function inlineImages(root: HTMLElement): Promise<void> {
  const imgs = Array.from(root.querySelectorAll<HTMLImageElement>("img"));
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.getAttribute("src") || "";
      if (!src || src.startsWith("data:")) return;
      const local = decodeTauriAsset(src);
      if (local) {
        const d = await readLocalAsDataUrl(local);
        if (d) img.setAttribute("src", d);
        return;
      }
      if (isExternal(src)) {
        const d = await fetchAsDataUrl(src);
        if (d) img.setAttribute("src", d);
      }
    })
  );
}

/** 给所有 svg 元素补 xmlns 属性（inline HTML 里没有它 Edge 会拒绝渲染）。 */
export function ensureSvgNamespace(root: HTMLElement): void {
  root.querySelectorAll<SVGSVGElement>("svg").forEach((svg) => {
    if (!svg.getAttribute("xmlns")) {
      svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    }
  });
}
