// E3 §5: one uploaded image -> assets/<sha256>.<ext> + uploads.json (the asset map entry the emitter merges, R7).
// The type comes from the extension AND the magic bytes; an SVG is sanitized first; 25 MB per file, 500 MB per project.
// sniffImage / sanitizeSvg are pure; the rest touches only <ws>/assets and <ws>/uploads.json.
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_BUDGET_BYTES, MAX_FILE_BYTES } from "./assets";
import { AppError, Codes } from "./errors";
import { fileExists, writeFileAtomic, writeJsonAtomic } from "./fsx";
import { mapLimit } from "./limit";

export const UPLOAD_ORIGIN = "https://upload.aiwc.invalid/"; // http(s) so the emitter maps it; .invalid never resolves
export type ImageKind = "png" | "jpg" | "gif" | "webp" | "avif" | "svg";
export type LibraryAsset = { key: string; url: string; size: number; type: string };
const EXT: Record<string, ImageKind> = { png: "png", jpg: "jpg", jpeg: "jpg", gif: "gif", webp: "webp", avif: "avif", svg: "svg" };
const STORED = /^assets\/[0-9a-f]{64}\.(?:png|jpg|gif|webp|avif|svg)$/;
const LIBRARY_LIMIT = 500;
const STAT_CONCURRENCY = 8;
function invalid(message: string): never {
  throw new AppError(Codes.UPLOAD_INVALID, message);
}

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
// The comment group is tempered (never spans a "-->"): a lazy [\s\S]*? under * backtracks exponentially.
const SVG_HEAD = /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--(?:(?!-->)[\s\S])*-->\s*)*(?:<!DOCTYPE svg[^>[]*>\s*)?<svg[\s>/]/i;
export function sniffImage(b: Uint8Array): ImageKind | undefined {
  if (b.length >= 8 && ascii(b, 0, 8) === "\x89PNG\r\n\x1a\n") return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length >= 6 && /^GIF8[79]a$/.test(ascii(b, 0, 6))) return "gif";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "webp";
  if (b.length >= 12 && ascii(b, 4, 8) === "ftyp") {
    const size = Math.min(b.length, ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0 || 12);
    for (let at = 8; at + 4 <= size; at += 4) if (/^avi[fs]$/.test(ascii(b, at, at + 4))) return "avif"; // major + compatible brands
  }
  const head = new TextDecoder().decode(b.subarray(0, 1024)).replace(/^\uFEFF/, "");
  return SVG_HEAD.test(head) ? "svg" : undefined;
}

// --- sanitizeSvg: an allowlist rebuild (no DOM on the server) ---------------------------------------------------
// Only the root <svg> subtree of allowlisted SVG elements is written back, re-serialized from what was parsed, so
// the output is exactly what was checked: comments, DOCTYPE/ENTITY (no entity expansion) and processing
// instructions dropped; any other element (script, foreignObject, prefixed/HTML elements…) dropped WITH its
// content; on* attributes, foreign prefixes and namespace rebinding dropped; href only to a local #ref (plus raster
// data: on <image>/<feImage>, http(s)/mailto on <a>); animation of href or an event attribute dropped whole;
// url() only to #refs and no @import / CSS escapes / expression() in <style> or any attribute; javascript:/
// vbscript: in any value dropped. Values are decoded once and re-encoded (no HTML-only entity stays live, no char
// the XML parser rejects). Malformed markup is refused, never guessed at.
const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const ELEMENTS = new Map(
  ("svg g defs symbol use switch title desc metadata a view style path rect circle ellipse line polyline polygon text tspan " +
    "textPath image marker pattern clipPath mask linearGradient radialGradient stop filter feBlend feColorMatrix " +
    "feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap feDistantLight feDropShadow " +
    "feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feImage feMerge feMergeNode feMorphology feOffset fePointLight " +
    "feSpecularLighting feSpotLight feTile feTurbulence animate animateMotion animateTransform set mpath")
    .split(" ")
    .map((n) => [n.toLowerCase(), n]),
);
const ANIMATION = new Set(["animate", "animateMotion", "animateTransform", "set"]);
const RASTER_HOLDER = new Set(["image", "feImage"]);
const RASTER = /^data:image\/(?:png|jpe?g|gif|webp|avif)[;,]/;
// Anything that fetches (url() other than a #ref, image-set(), src(), @import, @font-face) or runs (expression,
// bindings, script URLs); a backslash is refused outright (CSS escapes can spell any of these).
const UNSAFE_CSS = /\\|@import|@font-face|expression\s*\(|-moz-binding|behavior\s*:|(?:java|vb)script:|image-set\s*\(|(?:^|[^\w-])src\s*\(|url\s*\(\s*(?!['"]?\s*#)/i;
const SCRIPT_URL = /(?:java|vb)script:/;
const NAME = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/;
// No "<" inside a tag (XML forbids it in attribute values): every match attempt ends at the next "<", so linear.
const TAG = /<(\/?)([A-Za-z_][^\s/><]*)((?:\s+[^\s=/><]+(?:\s*=\s*(?:"[^"<]*"|'[^'<]*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/y;
const ATTR = /([^\s=/><]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const DOCTYPE = /<!DOCTYPE(?:"[^"]*"|'[^']*'|\[(?:"[^"]*"|'[^']*'|[^\]"'])*\]|[^>"'[])*>/y;
const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const clean = (s: string) => s.replace(/[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, "\uFFFD");
const decode = (s: string) =>
  clean(s.replace(/&(?:#x([0-9a-fA-F]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/g, (_, hex?: string, dec?: string, named?: string) => {
    if (named) return ENTITY[named]!;
    const cp = hex ? parseInt(hex, 16) : Number(dec);
    return String.fromCodePoint(cp <= 0x10ffff ? cp : 0xfffd);
  }));
const encodeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/]]>/g, "]]&gt;");
const encodeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const MAX_DEPTH = 1024; // open + dropped elements: deeper nesting is refused

// A tag stack whose "is <name> open?" is O(1): a stray close never scans it, a matched close pops what it closes.
class TagStack {
  readonly names: string[] = [];
  private counts = new Map<string, number>();
  push(name: string) {
    this.names.push(name);
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
  }
  pop(): string {
    const name = this.names.pop()!;
    this.counts.set(name, this.counts.get(name)! - 1);
    return name;
  }
  has(name: string) {
    return (this.counts.get(name) ?? 0) > 0;
  }
}
const malformed = (): never => invalid("Tệp .svg không hợp lệ (XML hỏng).");

// The kept attributes as ` name="value"`, or null when the element itself must go (animation of href / on*).
function svgAttrs(el: string, raw: string): string | null {
  const seen = new Set<string>();
  let out = "";
  for (const m of raw.matchAll(ATTR)) {
    const name = m[1]!, key = name.toLowerCase(), value = decode(m[2] ?? m[3] ?? m[4] ?? "");
    if (!NAME.test(name) || seen.has(key)) continue;
    const [prefix, local] = key.includes(":") ? (key.split(":") as [string, string]) : ["", key];
    const bare = value.replace(/[\u0000- ]/g, "").toLowerCase(); // browsers strip these before reading a scheme
    if (local.startsWith("on")) continue;
    if (key === "xmlns" || prefix === "xmlns") {
      if (key === "xmlns" ? value !== SVG_NS : key !== "xmlns:xlink" || value !== XLINK_NS) continue;
    } else if (prefix && prefix !== "xlink" && key !== "xml:space" && key !== "xml:lang") continue;
    else if (local === "href") {
      const ok = bare.startsWith("#") || (RASTER_HOLDER.has(el) && RASTER.test(bare)) || (el === "a" && /^(?:https?|mailto):/.test(bare));
      if (!ok) continue;
    } else if (SCRIPT_URL.test(bare) || UNSAFE_CSS.test(value)) continue;
    if (ANIMATION.has(el) && key === "attributename") {
      const target = bare.slice(bare.indexOf(":") + 1);
      if (target === "href" || target.startsWith("on")) return null;
    }
    seen.add(key);
    out += ` ${name}="${encodeAttr(value)}"`;
  }
  return out;
}

export function sanitizeSvg(text: string): string {
  const out: string[] = [];
  const open = new TagStack(); // kept elements still open (canonical names)
  const skip = new TagStack(); // a dropped element's subtree still open (lowercase names)
  let css: { attrs: string; parts: string[]; ok: boolean } | null = null; // inside a kept <style>
  let rooted = false, xlinkUsed = false;
  const content = (s: string) => {
    if (css) css.parts.push(s);
    else if (open.names.length && !skip.names.length) out.push(encodeText(s));
  };
  const enter = (stack: TagStack, name: string) => {
    if (open.names.length + skip.names.length >= MAX_DEPTH) invalid(`Tệp .svg lồng quá ${MAX_DEPTH} cấp.`);
    stack.push(name);
  };
  for (let i = 0; i < text.length && !(rooted && !open.names.length); ) {
    if (text[i] !== "<") {
      const next = text.indexOf("<", i);
      const end = next < 0 ? text.length : next;
      content(decode(text.slice(i, end)));
      i = end;
      continue;
    }
    const delimited = (start: string, stop: string) => {
      if (!text.startsWith(start, i)) return undefined;
      const end = text.indexOf(stop, i + start.length);
      if (end < 0) malformed();
      const inner = text.slice(i + start.length, end);
      i = end + stop.length;
      return inner;
    };
    if (delimited("<!--", "-->") !== undefined || delimited("<?", "?>") !== undefined) continue;
    const cdata = delimited("<![CDATA[", "]]>");
    if (cdata !== undefined) {
      content(clean(cdata));
      continue;
    }
    if (text.startsWith("<!", i)) {
      DOCTYPE.lastIndex = i;
      if (rooted || !DOCTYPE.test(text)) malformed();
      i = DOCTYPE.lastIndex;
      continue;
    }
    TAG.lastIndex = i;
    const tag = TAG.exec(text) ?? malformed();
    i = TAG.lastIndex;
    const close = tag[1] === "/", self = tag[4] === "/", lower = tag[2]!.toLowerCase(), el = ELEMENTS.get(lower);
    if (css) {
      if (close && lower === "style") {
        const body = css.parts.join("");
        if (css.ok && !UNSAFE_CSS.test(body)) out.push(`<style${css.attrs}>${encodeText(body)}</style>`);
        css = null;
      } else css.ok = false; // markup inside <style>
      continue;
    }
    if (skip.names.length) {
      if (!close) {
        if (!self) enter(skip, lower);
      } else if (skip.has(lower)) while (skip.pop() !== lower); // a stray close inside dropped content is ignored
      continue;
    }
    if (!rooted && (close || lower !== "svg")) invalid("Tệp .svg không có thẻ <svg> ở gốc.");
    if (close) {
      if (el && open.has(el)) for (let name = ""; name !== el; ) out.push(`</${(name = open.pop())}>`);
      continue;
    }
    const attrs = el ? svgAttrs(el, tag[3]!) : null;
    if (attrs === null) {
      if (!self) enter(skip, lower);
      continue;
    }
    if (attrs.includes(" xlink:")) xlinkUsed = true;
    rooted = true;
    if (el === "style") {
      if (!self) css = { attrs, parts: [], ok: true };
      continue;
    }
    out.push(`<${el}${attrs}${self ? "/>" : ">"}`);
    if (!self) enter(open, el!);
  }
  if (!rooted) invalid("Tệp .svg không có thẻ <svg>.");
  while (open.names.length) out.push(`</${open.pop()}>`);
  // a kept xlink:* attribute needs its prefix declared or the file doesn't parse (the root start tag is out[0])
  if (xlinkUsed && !out[0]!.includes(' xmlns:xlink="')) out[0] = out[0]!.replace(/\/?>$/, (end) => ` xmlns:xlink="${XLINK_NS}"${end}`);
  return out.join("");
}

// --- storage -----------------------------------------------------------------------------------------------------

// uploads.json as the asset map sees it: only entries this module could have written (key = UPLOAD_ORIGIN + the
// stored file name), so a tampered file never maps a path outside assets/.
export async function readUploads(ws: string): Promise<Record<string, string>> {
  const text = await readFile(join(ws, "uploads.json"), "utf8").catch((e: unknown) => {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "{}";
    throw e;
  });
  let map: unknown;
  try {
    map = JSON.parse(text);
  } catch {
    return {}; // unreadable: the next upload rewrites it; emit never fails on it
  }
  if (!map || typeof map !== "object" || Array.isArray(map)) return {};
  return Object.fromEntries(
    Object.entries(map).filter(([k, v]) => k.startsWith(UPLOAD_ORIGIN) && v === `assets/${k.slice(UPLOAD_ORIGIN.length)}` && STORED.test(v)),
  ) as Record<string, string>;
}

async function assetBytes(ws: string): Promise<number> {
  const names = await readdir(join(ws, "assets")).catch(() => [] as string[]);
  const sizes = await mapLimit(names, STAT_CONCURRENCY, async (n) => (await stat(join(ws, "assets", n)).catch(() => null))?.size ?? 0);
  return sizes.reduce((a, b) => a + b, 0);
}

// The client's file name only votes on the type (its extension); the stored path is the content hash.
export async function storeUpload(ws: string, fileName: string, bytes: Uint8Array, budget = DEFAULT_BUDGET_BYTES): Promise<{ key: string; file: string }> {
  if (bytes.byteLength > MAX_FILE_BYTES) throw new AppError(Codes.ASSET_TOO_LARGE, `Ảnh vượt ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  const ext = EXT[/\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase() ?? ""];
  const kind = sniffImage(bytes);
  if (!ext || kind !== ext) invalid("Chỉ nhận ảnh png/jpg/webp/gif/svg/avif — đuôi file và nội dung phải khớp.");
  let body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength); // a view, not a copy
  if (kind === "svg") {
    let text = "";
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      invalid("Tệp .svg không phải UTF-8 hợp lệ.");
    }
    body = Buffer.from(sanitizeSvg(text));
    // escaping can grow the text (a bare "&" -> "&amp;"): the stored file obeys the same cap
    if (body.byteLength > MAX_FILE_BYTES) throw new AppError(Codes.ASSET_TOO_LARGE, `Ảnh .svg sau khi làm sạch vượt ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  }
  const sha = createHash("sha256").update(body).digest("hex");
  const file = `assets/${sha}.${kind}`;
  if (!(await fileExists(join(ws, file)))) {
    if ((await assetBytes(ws)) + body.byteLength > budget) throw new AppError(Codes.PROJECT_SIZE_LIMIT, `Tổng asset của project vượt ${Math.round(budget / 1024 / 1024)} MB.`);
    await writeFileAtomic(join(ws, file), body);
  }
  const key = `${UPLOAD_ORIGIN}${sha}.${kind}`;
  const map = await readUploads(ws);
  if (map[key] !== file) await writeJsonAtomic(join(ws, "uploads.json"), { ...map, [key]: file });
  return { key, file };
}

// The editor's asset library (E3 §5 GET): each image file of the asset map once (first key wins, uploads first),
// files still on disk, at most 500. Fonts / media are not offered.
export async function assetLibrary(ws: string, assetMap: Record<string, string>, urlOf: (file: string) => string): Promise<LibraryAsset[]> {
  const byFile = new Map<string, string>();
  const entries = Object.entries(assetMap).sort(([a], [b]) => Number(b.startsWith(UPLOAD_ORIGIN)) - Number(a.startsWith(UPLOAD_ORIGIN)));
  for (const [key, file] of entries) if (STORED.test(file) && !byFile.has(file)) byFile.set(file, key);
  const picked = [...byFile].slice(0, LIBRARY_LIMIT);
  const rows = await mapLimit(picked, STAT_CONCURRENCY, async ([file, key]) => {
    const info = await stat(join(ws, file)).catch(() => null);
    return info?.isFile() ? { key, url: urlOf(file), size: info.size, type: file.slice(file.lastIndexOf(".") + 1) } : null;
  });
  return rows.filter((x): x is LibraryAsset => x !== null);
}
