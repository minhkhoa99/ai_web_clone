// AI section naming (1 generate call/page), safe fallback on any failure. Never throws.
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { AppError } from "./errors";
import { generate } from "./gateway";
import type { IR, IRNode, Section } from "./ir";

const MAX_TAG_DEPTH = 3;
const MAX_TEXT_CHARS = 200;
const MAX_NAME_CHARS = 60;
const MAX_ROLE_CHARS = 30;

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

function fallbackNames(ir: IR, sectionIds: string[]): SectionNames {
  const byId = new Map(ir.sections.map((s) => [s.id, s] as const));
  const names: SectionNames = {};
  sectionIds.forEach((id, i) => {
    names[id] = { name: `section-${i + 1}`, role: byId.get(id)?.role ?? "section" };
  });
  return names;
}

export async function nameSections(
  db: DatabaseSync,
  projectId: string,
  ir: IR,
  pageId: string,
  opts: { thumbnail?: string } = {},
): Promise<{ names: SectionNames; error?: string }> {
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
    });
    text = result.text;
  } catch (e) {
    return { names: fallbackNames(ir, sectionIds), error: e instanceof AppError ? e.code : "AI_BAD_RESPONSE" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { names: fallbackNames(ir, sectionIds), error: "AI_BAD_RESPONSE" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { names: fallbackNames(ir, sectionIds), error: "AI_BAD_RESPONSE" };
  }

  const byId = new Map(ir.sections.map((s) => [s.id, s] as const));
  const raw = parsed as Record<string, unknown>;
  const names: SectionNames = {};
  sectionIds.forEach((id, i) => {
    const candidate = entrySchema.safeParse(raw[id]);
    names[id] = candidate.success
      ? { name: toKebabCase(candidate.data.name), role: candidate.data.role.trim().slice(0, MAX_ROLE_CHARS) || "section" }
      : { name: `section-${i + 1}`, role: byId.get(id)?.role ?? "section" };
  });
  return { names };
}
