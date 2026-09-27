// AI section naming (1 generate call/page), safe fallback on any failure. Never throws.
import { PNG } from "pngjs";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { AppError } from "./errors";
import { generate, type ChatMessage, type GenerateOptions } from "./gateway";
import type { IR, IRNode, Section } from "./ir";

const MAX_TAG_DEPTH = 3;
const MAX_TEXT_CHARS = 200;
const MAX_NAME_CHARS = 60;
const MAX_ROLE_CHARS = 30;
const THUMB_MAX_WIDTH = 400;
const THUMB_MAX_HEIGHT = 1200;
// Real-run evidence (hardening spec §6, §8): a 5.1MB fix request (3 full-size crops), a 70,745-token naming
// call, and a proxy that counts base64 as text (one 1024x608 crop = 1 245 662 chars ≈ 311k tokens). Every
// image sent to AI is capped the same way, fix loop, inspector tool screenshots and naming thumbnail alike.
export const MAX_IMAGE_WIDTH = 1024;
export const MAX_IMAGES_B64 = 384 * 1024;
const MAX_HALVINGS = 4;
const MAX_NAMING_CHARS = 24_000;
// Real-run evidence (hardening spec §8): a 1 424 391-byte fix request ≈ 360 738 tokens against a 270k limit.
export const MAX_REQUEST_TOKENS = 120_000;
const MAX_SHRINK_STEPS = 3;

export type OutlineTag = { tag: string; children: OutlineTag[] };
export type SectionOutline = { id: string; tag: OutlineTag; text: string };
export type SectionNames = Record<string, { name: string; role: string }>;

function outlineTag(node: IRNode, depth: number): OutlineTag {
  const children = depth < MAX_TAG_DEPTH ? node.children.map((c) => outlineTag(c, depth + 1)) : [];
  return { tag: node.tag, children };
}

function collectText(node: IRNode, out: string[]): void {
  if (node.text) out.push(node.text);
  for (const child of node.children) collectText(child, out);
}

// PURE. No attrs, no values -> secrets in captured DOM (e.g. input value) never appear here.
export function buildOutline(ir: IR, pageId: string): SectionOutline[] {
  const page = ir.pages.find((p) => p.id === pageId);
  if (!page) return [];
  const byId = new Map(ir.sections.map((s) => [s.id, s] as const));
  return page.sectionIds.map((id) => {
    const section = byId.get(id)!;
    const texts: string[] = [];
    collectText(section.root, texts);
    return { id, tag: outlineTag(section.root, 1), text: texts.join(" ").slice(0, MAX_TEXT_CHARS) };
  });
}

// PURE. Section descriptions ("text") capped at maxChars total across the whole page (a page with many
// sections can otherwise still blow the naming prompt past the per-section 200-char cap). The section
// where the running budget runs out gets a trailing "…"; later sections lose their text entirely.
export function capOutlineText(outline: SectionOutline[], maxChars = MAX_NAMING_CHARS): SectionOutline[] {
  let budget = maxChars;
  return outline.map((o) => {
    if (budget <= 0) return o.text ? { ...o, text: "" } : o;
    if (o.text.length <= budget) {
      budget -= o.text.length;
      return o;
    }
    const text = `${o.text.slice(0, Math.max(0, budget - 1))}…`;
    budget = 0;
    return { ...o, text };
  });
}

// PURE. Nearest-neighbour downscale to <= maxWidth (aspect kept, no height cap). Shared by thumbnailOf and
// fitImages so there is exactly one resampler.
function scaleToWidth(src: PNG, maxWidth: number): PNG {
  const scale = Math.min(1, maxWidth / src.width);
  const width = Math.max(1, Math.round(src.width * scale));
  const height = Math.max(1, Math.round(src.height * scale));
  const out = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    const sy = Math.min(src.height - 1, Math.floor(y / scale));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(src.width - 1, Math.floor(x / scale));
      src.data.copy(out.data, (y * width + x) * 4, (sy * src.width + sx) * 4, (sy * src.width + sx) * 4 + 4);
    }
  }
  return out;
}

// PURE. Nearest-neighbour downscale of the 1440 page shot for the naming call: <= 400px wide, and a very tall
// page keeps only its top (<= 1200px tall), so the image stays small whatever the page length.
export function thumbnailOf(src: PNG, maxWidth = THUMB_MAX_WIDTH, maxHeight = THUMB_MAX_HEIGHT): PNG {
  const scaled = scaleToWidth(src, maxWidth);
  if (scaled.height <= maxHeight) return scaled;
  const out = new PNG({ width: scaled.width, height: maxHeight });
  scaled.data.copy(out.data, 0, 0, maxHeight * scaled.width * 4);
  return out;
}

// PURE. Encoded PNGs -> base64 strings, in the order given, each downscaled to <= maxWidth. If the summed
// base64 still exceeds maxTotalB64, images are dropped from the END of the array (spec order: pass
// [orig, clone, heat] so heat drops first, then clone) until one is left; if that lone survivor is still
// over, its width is halved up to MAX_HALVINGS times. Bounded, never throws: worst case it sends what's left.
// A buffer that does not decode (hardening spec §8: an encoded 0-height crop) is skipped.
export function fitImages(pngBuffers: Buffer[], opts: { maxWidth: number; maxTotalB64: number }): string[] {
  const decoded = pngBuffers.flatMap((buf) => {
    try {
      return [PNG.sync.read(buf)];
    } catch {
      return [];
    }
  });
  let width = opts.maxWidth;
  let kept = decoded.length;
  for (let halving = 0; halving <= MAX_HALVINGS; halving++) {
    const encoded = decoded.slice(0, kept).map((png) => PNG.sync.write(scaleToWidth(png, width)).toString("base64"));
    const total = () => encoded.reduce((sum, b) => sum + b.length, 0);
    while (encoded.length > 1 && total() > opts.maxTotalB64) {
      encoded.pop();
      kept--;
    }
    if (total() <= opts.maxTotalB64 || halving === MAX_HALVINGS) return encoded;
    width = Math.max(1, Math.round(width / 2));
  }
  return []; // unreachable (loop always returns on its last iteration)
}

// PURE. Worst-case token estimate of one request: chars / 4 over the serialized messages plus the base64 images
// (a proxy may count an image's base64 as text).
export const estimateTokens = (messages: ChatMessage[], images: string[] = []): number =>
  Math.ceil((JSON.stringify(messages).length + images.reduce((n, b) => n + b.length, 0)) / 4);

// PURE. One request under maxTokens: images dropped from the end first (heat, then clone, then orig), then the
// text rebuilt by `build` at 1/2, 1/4, 1/8 of its budgets; still over after that, it goes as is (the provider decides).
export function fitRequest(build: (scale: number) => ChatMessage[], images: string[], maxTokens = MAX_REQUEST_TOKENS): { messages: ChatMessage[]; images: string[] } {
  let messages = build(1);
  let kept = images;
  const fits = () => estimateTokens(messages, kept) <= maxTokens;
  while (kept.length > 0 && !fits()) kept = kept.slice(0, -1);
  for (let step = 1; step <= MAX_SHRINK_STEPS && !fits(); step++) messages = build(0.5 ** step);
  return { messages, images: kept };
}

// PURE, immutable. Only touches Section.name/role.
export function applySectionNames(ir: IR, names: SectionNames): IR {
  const sections: Section[] = ir.sections.map((s) => {
    const entry = names[s.id];
    return entry ? { ...s, name: entry.name, role: entry.role } : s;
  });
  return { ...ir, sections };
}

function toKebabCase(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (slug.slice(0, MAX_NAME_CHARS).replace(/-+$/, "") || "section").slice(0, MAX_NAME_CHARS);
}

const entrySchema = z.object({ name: z.string(), role: z.string() });

// section-N = the section's 1-based position on the page that owns it (a shared layout's owner is its first
// page), the same N ir.ts assigned. Keyed by section so naming page B never renumbers page A's shared layout.
function positionName(ir: IR, section: Section | undefined, fallbackIndex: number): string {
  const owner = section && ir.pages.find((p) => p.id === section.pageId);
  const pos = owner ? owner.sectionIds.indexOf(section.id) : -1;
  return `section-${(pos >= 0 ? pos : fallbackIndex) + 1}`;
}

// Only sections this page owns: a shared layout owned by another page keeps its name (maybe an AI one).
function fallbackNames(ir: IR, pageId: string, sectionIds: string[]): SectionNames {
  const byId = new Map(ir.sections.map((s) => [s.id, s] as const));
  const names: SectionNames = {};
  sectionIds.forEach((id, i) => {
    const section = byId.get(id);
    if (section && section.pageId !== pageId) return;
    names[id] = { name: positionName(ir, section, i), role: section?.role ?? "section" };
  });
  return names;
}

export async function nameSections(
  db: DatabaseSync,
  projectId: string,
  ir: IR,
  pageId: string,
  opts: { thumbnail?: string; signal?: AbortSignal; onRetry?: GenerateOptions["onRetry"] } = {},
): Promise<{ names: SectionNames; error?: string; errorMessage?: string }> {
  const page = ir.pages.find((p) => p.id === pageId);
  const sectionIds = page?.sectionIds ?? [];
  const outline = buildOutline(ir, pageId);
  const request = fitRequest(
    (scale) => [
      { role: "system", content: "Name each web page section and classify its role. Respond with JSON: {sectionId: {name, role}}." },
      { role: "user", content: JSON.stringify(capOutlineText(outline, Math.floor(MAX_NAMING_CHARS * scale))) },
    ],
    opts.thumbnail ? [opts.thumbnail] : [],
  );

  let text: string;
  try {
    const result = await generate(db, {
      role: "vision",
      projectId,
      messages: request.messages,
      jsonSchema: {
        name: "section_names",
        schema: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: { name: { type: "string" }, role: { type: "string" } },
            required: ["name", "role"],
          },
        },
      },
      ...(request.images.length ? { images: request.images } : {}),
      signal: opts.signal,
      onRetry: opts.onRetry,
    });
    text = result.text;
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    return { names: fallbackNames(ir, pageId, sectionIds), error: e instanceof AppError ? e.code : "AI_BAD_RESPONSE", errorMessage };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { names: fallbackNames(ir, pageId, sectionIds), error: "AI_BAD_RESPONSE", errorMessage: "naming reply is not JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { names: fallbackNames(ir, pageId, sectionIds), error: "AI_BAD_RESPONSE", errorMessage: "naming reply is not a JSON object" };
  }

  const raw = parsed as Record<string, unknown>;
  const names: SectionNames = {};
  const fallback = fallbackNames(ir, pageId, sectionIds);
  for (const id of sectionIds) {
    const candidate = entrySchema.safeParse(raw[id]);
    if (candidate.success) names[id] = { name: toKebabCase(candidate.data.name), role: candidate.data.role.trim().slice(0, MAX_ROLE_CHARS) || "section" };
    else if (fallback[id]) names[id] = fallback[id];
  }
  return { names };
}
