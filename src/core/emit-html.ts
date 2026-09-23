// IR -> out/. renderSite/emitSection are pure (string in, string out); emitHtml is the thin writer.
import { copyFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { categoryOf, type Decl } from "./dedupe";
import type { Interaction } from "./interactions";
import type { IR, IRNode, Page, Section } from "./ir";
import { mapLimit } from "./limit";
import { normalizeUrl } from "./url";

export type RenderOpts = {
  assetMap: Record<string, string>; // absolute url -> "assets/<sha>.<ext>"
  pageUrls: Record<string, string>; // pageId -> original url
  stripIds?: boolean;
};
export type EmitOpts = RenderOpts & { outDir: string; workspaceDir: string };

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const BEHAVIOR_ATTR: Partial<Record<Interaction["kind"], string>> = {
  menu: "toggle",
  accordion: "toggle",
  tab: "tabs",
  modal: "modal",
  carousel: "carousel",
  sticky: "sticky",
};
const STATES = ["hover", "focus", "active"] as const;
const SAFE_ATTR_NAME = /^[^\s"'<>/=]+$/;
const SAFE_TAG = /^[a-zA-Z][a-zA-Z0-9-]*$/;
const PROPERTY_META = /^(og|fb|article):/;
const HEAD_META_SKIP = new Set(["viewport", "charset"]);
const MEDIA_768 = "@media (max-width: 1439.98px)";
const MEDIA_375 = "@media (max-width: 767.98px)";
const ASSET_REF = /assets\/[0-9a-f]{64}\.[a-z0-9]{1,8}/g;
const WRITE_CONCURRENCY = 8;
const RUNTIME_SRC = fileURLToPath(new URL("./runtime.js", import.meta.url));

type Ctx = {
  opts: RenderOpts;
  sections: Map<string, Section>;
  kinds: Map<string, Interaction["kind"]>;
  pageFiles: Map<string, string>; // normalized page url -> local file
  assetKeys: string[]; // sorted assetMap keys, for relative-path fallback in CSS
};

const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => escText(s).replace(/"/g, "&quot;");

function resolveHttp(raw: string, base: string | undefined): URL | null {
  if (!raw || raw.startsWith("#")) return null;
  try {
    const u = new URL(raw, base);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

// Asset -> local relative path (prefixed for CSS), anything else -> absolute; unresolvable -> verbatim.
function assetUrl(raw: string, base: string | undefined, ctx: Ctx, prefix = ""): string {
  const u = resolveHttp(raw.trim(), base);
  if (!u) return raw;
  const full = u.href;
  const exact = ctx.opts.assetMap[full];
  if (exact) return prefix + exact;
  const hash = u.hash;
  u.hash = "";
  const bare = ctx.opts.assetMap[u.href];
  return bare ? prefix + bare + hash : full;
}

function pageLink(raw: string, base: string | undefined, ctx: Ctx): string {
  const u = resolveHttp(raw.trim(), base);
  if (!u) return raw;
  const file = ctx.pageFiles.get(normalizeUrl(u.href) ?? "");
  return file ? file + u.hash : u.href;
}

function rewriteAttr(node: IRNode, name: string, value: string, base: string | undefined, ctx: Ctx): string {
  switch (name) {
    case "src":
    case "poster":
      return node.attrs["data-dynamic"] === "canvas" ? value : assetUrl(value, base, ctx);
    case "href":
    case "xlink:href":
      return node.tag === "a" ? pageLink(value, base, ctx) : assetUrl(value, base, ctx);
    case "srcset":
      // Candidates are separated by comma + whitespace; bare commas belong to the URL (CDN params, data: URIs).
      return value
        .split(/,\s+/)
        .map((candidate) => {
          const [url = "", ...descriptors] = candidate.trim().split(/\s+/);
          return [assetUrl(url, base, ctx), ...descriptors].join(" ");
        })
        .join(", ");
    default:
      return value;
  }
}

// Browsers strip whitespace/control chars before reading the scheme ("java\tscript:" still runs).
export const isJavascriptUrl = (value: string) => value.replace(/[\u0000-\u0020]/g, "").toLowerCase().startsWith("javascript:");

function renderAttrs(node: IRNode, base: string | undefined, ctx: Ctx): string {
  let out = "";
  for (const [name, value] of Object.entries(node.attrs)) {
    if (name === "class" || name === "srcdoc" || /^on/i.test(name) || !SAFE_ATTR_NAME.test(name)) continue;
    if (isJavascriptUrl(value)) {
      if (name === "href") out += ` href="#"`;
      continue;
    }
    out += ` ${name}="${escAttr(rewriteAttr(node, name, value, base, ctx))}"`;
  }
  const cls = new Set(node.cls);
  for (const state of STATES) if (node.states?.[state]) cls.add(`st-${node.states[state]}`);
  if (cls.size > 0) out += ` class="${escAttr([...cls].join(" "))}"`;
  if (node.behavior) {
    const kind = ctx.kinds.get(node.behavior);
    const behavior = kind && BEHAVIOR_ATTR[kind];
    out += behavior ? ` data-behavior="${behavior}" data-ix="${escAttr(node.behavior)}"` : ` data-behavior="unresolved"`;
  }
  if (!ctx.opts.stripIds) out += ` data-ir-id="${escAttr(node.id)}"`;
  return out;
}

function renderNode(node: IRNode, base: string | undefined, ctx: Ctx, out: string[]): void {
  if (node.tag === "#text") {
    out.push(escText(node.text ?? ""));
    return;
  }
  if (node.tag === "#section") {
    const id = node.attrs["data-section"] ?? "";
    const section = ctx.sections.get(id);
    if (!section) throw new Error(`emit: shell references unknown section ${id} (placeholder ${node.id})`);
    renderNode(section.root, ctx.opts.pageUrls[section.pageId], ctx, out);
    return;
  }
  // Defense in depth (tags can come from AI patches): an unsafe tag name or a script is never written.
  if (!SAFE_TAG.test(node.tag) || node.tag.toLowerCase() === "script") return;
  out.push(`<${node.tag}${renderAttrs(node, base, ctx)}>`);
  if (VOID_TAGS.has(node.tag)) return;
  // iframe children are the captured inner document; the HTML parser would show them as text.
  if (node.tag !== "iframe") for (const child of node.children) renderNode(child, base, ctx, out);
  out.push(`</${node.tag}>`);
}

// "/" -> index, "/a/b" -> a-b, "/x.html" -> x; case-insensitive collisions get -2, -3 in page order.
export function pageFileNames(pages: Page[]): Map<string, string> {
  const used = new Set<string>();
  const names = new Map<string, string>();
  for (const page of pages) {
    const slug =
      page.path
        .replace(/\.html?(?=$|\?)/i, "")
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "index";
    let name = slug;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${slug}-${n}`;
    used.add(name.toLowerCase());
    names.set(page.id, `${name}.html`);
  }
  return names;
}

function makeCtx(ir: IR, opts: RenderOpts, fileByPage: Map<string, string>): Ctx {
  const pageFiles = new Map<string, string>();
  for (const [pageId, file] of fileByPage) {
    const url = normalizeUrl(opts.pageUrls[pageId] ?? "");
    if (url && !pageFiles.has(url)) pageFiles.set(url, file);
  }
  return {
    opts,
    sections: new Map(ir.sections.map((s) => [s.id, s])),
    kinds: new Map(ir.interactions.map((it) => [it.id, it.kind])),
    pageFiles,
    assetKeys: Object.keys(opts.assetMap).sort(),
  };
}

function renderPage(page: Page, ctx: Ctx): string {
  const base = ctx.opts.pageUrls[page.id];
  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escText(page.title)}</title>`,
    ...Object.entries(page.meta)
      .filter(([key]) => !HEAD_META_SKIP.has(key))
      .map(([key, content]) => `<meta ${PROPERTY_META.test(key) ? "property" : "name"}="${escAttr(key)}" content="${escAttr(content)}">`),
    '<link rel="stylesheet" href="css/styles.css">',
    '<script src="js/runtime.js" defer></script>',
  ];
  const body: string[] = [];
  for (const child of page.shell.children) renderNode(child, base, ctx, body);
  return `<!DOCTYPE html>\n<html${renderAttrs(page.shell, base, ctx)}><head>\n${head.join("\n")}\n</head>${body.join("")}</html>\n`;
}

// --- CSS ---------------------------------------------------------------------

// Relative url() from a captured stylesheet (e.g. @font-face) whose sheet URL is unknown:
// match the downloaded asset whose path ends with it.
function assetBySuffix(raw: string, ctx: Ctx): string | undefined {
  const suffix = "/" + raw.replace(/^(\.\.?\/)+/, "").split(/[?#]/)[0];
  if (suffix === "/" || /^[a-z]+:|^\//i.test(raw)) return undefined;
  const key = ctx.assetKeys.find((k) => new URL(k).pathname.endsWith(suffix));
  return key && `../${ctx.opts.assetMap[key]}`;
}

function rewriteCssUrls(value: string, base: string | undefined, ctx: Ctx): string {
  if (!value.includes("url(")) return value;
  return value.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/g, (match, quote: string, raw: string) => {
    const resolved = assetUrl(raw, base, ctx, "../");
    const isLocal = resolved !== raw && resolved.startsWith("../");
    const out = isLocal ? resolved : (assetBySuffix(raw, ctx) ?? resolved);
    return out === raw ? match : `url(${quote}${out}${quote})`;
  });
}

function tokenLookup(tokens: Record<string, string>): Map<string, string> {
  const byValue = new Map<string, string>();
  for (const [name, value] of Object.entries(tokens)) {
    const category = name.slice(2, name.lastIndexOf("-"));
    const key = `${category}|${value}`;
    if (!byValue.has(key)) byValue.set(key, name);
  }
  return byValue;
}

function renderCss(ir: IR, ctx: Ctx): string {
  const base = ir.pages[0] ? ctx.opts.pageUrls[ir.pages[0].id] : undefined;
  const tokenOf = tokenLookup(ir.tokens);
  const decls = (decl: Decl) =>
    Object.entries(decl)
      .map(([prop, value]) => {
        const token = tokenOf.get(`${categoryOf(prop)}|${value}`);
        return `${prop}:${token ? `var(${token})` : rewriteCssUrls(value, base, ctx)}`;
      })
      .join(";");
  const rule = (selector: string, decl: Decl | undefined) => (decl && Object.keys(decl).length > 0 ? `${selector}{${decls(decl)}}` : "");

  const root = [
    ...Object.entries(ir.tokens),
    ...Object.entries(ir.cssom.vars).filter(([name]) => !Object.hasOwn(ir.tokens, name)),
  ].map(([name, value]) => `${name}:${value}`);
  const lines: string[] = [`:root{${root.join(";")}}`];
  lines.push(...ir.cssom.fontFace.map((f) => rewriteCssUrls(f, base, ctx)), ...ir.cssom.keyframes);

  const names = Object.keys(ir.classes).sort();
  for (const name of names) {
    const style = ir.classes[name]!;
    lines.push(rule(`.${name}`, style.base), rule(`.${name}::before`, style.before), rule(`.${name}::after`, style.after));
  }

  const stateRules = new Set<string>();
  const collectStates = (node: IRNode): void => {
    for (const state of STATES) if (node.states?.[state]) stateRules.add(`${node.states[state]}:${state}`);
    node.children.forEach(collectStates);
  };
  ir.sections.forEach((s) => collectStates(s.root));
  ir.pages.forEach((p) => collectStates(p.shell));
  // key "<cls>:<state>" doubles as the selector suffix: `.st-<cls>:<state>`.
  for (const key of [...stateRules].sort()) lines.push(rule(`.st-${key}`, ir.classes[key.slice(0, key.lastIndexOf(":"))]?.base));

  const at768: string[] = [];
  const at375: string[] = [];
  for (const name of names) {
    const { base: baseDecl, media } = ir.classes[name]!;
    const m768 = media?.["768"] ?? {};
    // 375 rules must undo 768-only props, which would otherwise leak below 768px.
    const eff375: Decl = { ...media?.["375"] };
    for (const prop of Object.keys(m768)) if (!Object.hasOwn(eff375, prop)) eff375[prop] = baseDecl[prop] ?? "revert";
    at768.push(rule(`.${name}`, m768));
    at375.push(rule(`.${name}`, eff375));
  }
  const block = (media: string, rules: string[]) => {
    const body = rules.filter(Boolean);
    return body.length > 0 ? `${media}{\n${body.join("\n")}\n}` : "";
  };
  lines.push(block(MEDIA_768, at768), block(MEDIA_375, at375));
  return lines.filter(Boolean).join("\n") + "\n";
}

// --- public API ----------------------------------------------------------------

// Every text file of out/ except js/runtime.js: one .html per page + css/styles.css.
export function renderSite(ir: IR, opts: RenderOpts): Record<string, string> {
  const fileByPage = pageFileNames(ir.pages);
  const ctx = makeCtx(ir, opts, fileByPage);
  const files: Record<string, string> = {};
  for (const page of ir.pages) files[fileByPage.get(page.id)!] = renderPage(page, ctx);
  files["css/styles.css"] = renderCss(ir, ctx);
  return files;
}

// css/styles.css on its own (the editor canvas stylesheet).
export function renderStylesheet(ir: IR, opts: RenderOpts): string {
  return renderCss(ir, makeCtx(ir, opts, pageFileNames(ir.pages)));
}

// HTML of one section (same renderer as the pages), for QA re-emit.
export function emitSection(ir: IR, sectionId: string, opts: RenderOpts): string {
  const section = ir.sections.find((s) => s.id === sectionId);
  if (!section) throw new Error(`emit: unknown section ${sectionId}`);
  const out: string[] = [];
  renderNode(section.root, opts.pageUrls[section.pageId], makeCtx(ir, opts, pageFileNames(ir.pages)), out);
  return out.join("");
}

async function writeAtomic(path: string, write: (tmp: string) => Promise<void>): Promise<void> {
  const tmp = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await write(tmp);
  await rename(tmp, path);
}

// Writes renderSite output, js/runtime.js and every asset the output references (workspaceDir/assets -> out/assets).
export async function emitHtml(ir: IR, opts: EmitOpts): Promise<void> {
  const files = renderSite(ir, opts);
  // outDir is wiped first so pages/assets from an earlier emit never survive a re-emit.
  // Refuse when outDir is (or contains) the workspace, which holds the captures and assets.
  const fromOut = relative(resolve(opts.outDir), resolve(opts.workspaceDir));
  if (!fromOut.startsWith("..") && !/^[a-zA-Z]:/.test(fromOut)) {
    throw new Error(`emit: outDir ${opts.outDir} must not contain workspaceDir ${opts.workspaceDir}`);
  }
  await rm(opts.outDir, { recursive: true, force: true });
  const assets = new Set<string>();
  for (const text of Object.values(files)) for (const [ref] of text.matchAll(ASSET_REF)) assets.add(ref);

  const copyAsset = (rel: string) =>
    writeAtomic(join(opts.outDir, rel), (tmp) => copyFile(join(opts.workspaceDir, rel), tmp)).catch((err: unknown) => {
      throw new Error(`emit: copying asset ${rel} from ${opts.workspaceDir} failed`, { cause: err });
    });
  await Promise.all([
    mapLimit(Object.entries(files), WRITE_CONCURRENCY, ([rel, text]) => writeAtomic(join(opts.outDir, rel), (tmp) => writeFile(tmp, text))),
    writeAtomic(join(opts.outDir, "js/runtime.js"), (tmp) => copyFile(RUNTIME_SRC, tmp)),
    mapLimit([...assets].sort(), WRITE_CONCURRENCY, copyAsset),
  ]);
}
