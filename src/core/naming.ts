// AI section naming (1 generate call/page), safe fallback on any failure. Never throws.
import { PNG } from "pngjs";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { AppError } from "./errors";
import { generate, type GenerateOptions } from "./gateway";
import type { IR, IRNode, Section } from "./ir";

const MAX_TAG_DEPTH = 3;
const MAX_TEXT_CHARS = 200;
const MAX_NAME_CHARS = 60;
const MAX_ROLE_CHARS = 30;
const THUMB_MAX_WIDTH = 400;
const THUMB_MAX_HEIGHT = 1200;

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

// PURE. Nearest-neighbour downscale of the 1440 page shot for the naming call: <= 400px wide, and a very tall
// page keeps only its top (<= 1200px tall), so the image stays small whatever the page length.
export function thumbnailOf(src: PNG, maxWidth = THUMB_MAX_WIDTH, maxHeight = THUMB_MAX_HEIGHT): PNG {
  const scale = Math.min(1, maxWidth / src.width);
  const width = Math.max(1, Math.round(src.width * scale));
  const height = Math.max(1, Math.min(maxHeight, Math.round(src.height * scale)));
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

  let text: string;
  try {
    const result = await generate(db, {
      role: "vision",
      projectId,
      messages: [
        { role: "system", content: "Name each web page section and classify its role. Respond with JSON: {sectionId: {name, role}}." },
        { role: "user", content: JSON.stringify(outline) },
      ],
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
      ...(opts.thumbnail ? { images: [opts.thumbnail] } : {}),
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
