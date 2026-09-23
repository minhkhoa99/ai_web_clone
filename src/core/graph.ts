// Graph store: writeGraph persists an IR as nodes/edges; the rest are prewritten,
// bounded read queries over that store (AI never writes SQL itself). No pure logic
// here beyond the queries — I/O only.
import type { DatabaseSync } from "node:sqlite";
import type { StyleSet } from "./dedupe";
import { AppError, Codes } from "./errors";
import { tx } from "./db";
import type { IR, IRNode, Layout, Section } from "./ir";
import type { Interaction } from "./interactions";

// Bounded result sizes for the per-section context queries and for listing layouts — a query
// never returns an unbounded list. `interactions` mirrors spec §1's 300/page cap; `tokens` and
// `assets` have no spec-given cap, so these are generous, arbitrary-but-bounded ceilings.
const CONTEXT_LIMITS = { tokens: 500, assets: 500, interactions: 300 } as const;
const MAX_LAYOUTS = 1000;

type StoredSection = Section & { classes: Record<string, StyleSet> };

function declValues(style: StyleSet): string[] {
  return [
    ...Object.values(style.base),
    ...Object.values(style.before ?? {}),
    ...Object.values(style.after ?? {}),
    ...Object.values(style.media?.["375"] ?? {}),
    ...Object.values(style.media?.["768"] ?? {}),
  ];
}

type SectionIndex = { classes: Set<string>; attrValues: string[]; behaviors: Set<string>; nodeIds: Set<string> };

function indexSubtree(root: IRNode): SectionIndex {
  const classes = new Set<string>();
  const attrValues: string[] = [];
  const behaviors = new Set<string>();
  const nodeIds = new Set<string>();
  const walk = (n: IRNode): void => {
    nodeIds.add(n.id);
    for (const c of n.cls) classes.add(c);
    if (n.states?.hover) classes.add(n.states.hover);
    if (n.states?.focus) classes.add(n.states.focus);
    if (n.states?.active) classes.add(n.states.active);
    for (const v of Object.values(n.attrs)) attrValues.push(v);
    if (n.behavior) behaviors.add(n.behavior);
    for (const child of n.children) walk(child);
  };
  walk(root);
  return { classes, attrValues, behaviors, nodeIds };
}

function usedClasses(idx: SectionIndex, classes: IR["classes"]): Record<string, StyleSet> {
  const out: Record<string, StyleSet> = {};
  for (const cls of idx.classes) if (classes[cls]) out[cls] = classes[cls];
  return out;
}

/**
 * Writes an IR into the graph store for `projectId`, one transaction: first deletes that
 * project's existing nodes/edges (idempotent rewrite), then inserts nodes for every
 * Page/Section/Layout/Component/Token/Asset/Interaction and the edges between them.
 * `assets` maps original asset URL -> relative output path (as captured, see PageCapture.assets).
 */
export function writeGraph(db: DatabaseSync, projectId: string, ir: IR, assets: Record<string, string>): void {
  tx(db, () => {
    db.prepare("DELETE FROM edges WHERE project_id=?").run(projectId);
    db.prepare("DELETE FROM nodes WHERE project_id=?").run(projectId);

    const insertNode = db.prepare("INSERT INTO nodes(id,project_id,type,key,data_json) VALUES(?,?,?,?,?)");
    const insertEdge = db.prepare("INSERT INTO edges(project_id,src,dst,type) VALUES(?,?,?,?)");

    for (const page of ir.pages) insertNode.run(page.id, projectId, "Page", page.path, JSON.stringify(page));
    const sectionIndex = new Map(ir.sections.map((s) => [s.id, indexSubtree(s.root)]));
    for (const section of ir.sections) {
      const stored: StoredSection = { ...section, classes: usedClasses(sectionIndex.get(section.id)!, ir.classes) };
      insertNode.run(section.id, projectId, "Section", section.id, JSON.stringify(stored));
    }
    for (const layout of ir.layouts) insertNode.run(layout.id, projectId, "Layout", layout.hash, JSON.stringify(layout));
    for (const component of ir.components) insertNode.run(component.id, projectId, "Component", component.hash, JSON.stringify(component));
    for (const [name, value] of Object.entries(ir.tokens)) insertNode.run(`token:${name}`, projectId, "Token", name, JSON.stringify(value));
    for (const [url, relPath] of Object.entries(assets)) insertNode.run(`asset:${relPath}`, projectId, "Asset", url, JSON.stringify({ url, relPath }));
    for (const interaction of ir.interactions) insertNode.run(interaction.id, projectId, "Interaction", interaction.trigger, JSON.stringify(interaction));

    for (const page of ir.pages) for (const sectionId of page.sectionIds) insertEdge.run(projectId, page.id, sectionId, "HAS_SECTION");
    for (const layout of ir.layouts) for (const pageId of layout.pageIds) insertEdge.run(projectId, pageId, layout.id, "USES_LAYOUT");

    const linkedInteractions = new Set<string>();
    for (const section of ir.sections) {
      const idx = sectionIndex.get(section.id)!;
      const declVals = [...idx.classes].flatMap((cls) => declValues(ir.classes[cls] ?? { base: {} }));

      for (const component of ir.components) {
        if (component.instanceIds.some((id) => idx.nodeIds.has(id))) insertEdge.run(projectId, section.id, component.id, "INSTANCE_OF");
      }
      for (const [name, value] of Object.entries(ir.tokens)) {
        if (declVals.includes(value)) insertEdge.run(projectId, section.id, `token:${name}`, "USES_TOKEN");
      }
      for (const [url, relPath] of Object.entries(assets)) {
        const used = idx.attrValues.includes(url) || declVals.some((v) => v.includes(url));
        if (used) insertEdge.run(projectId, section.id, `asset:${relPath}`, "USES_ASSET");
      }
      for (const interaction of ir.interactions) {
        if (idx.behaviors.has(interaction.id)) {
          insertEdge.run(projectId, section.id, interaction.id, "TRIGGERS");
          linkedInteractions.add(interaction.id);
        }
      }
    }
    for (const interaction of ir.interactions) {
      if (!linkedInteractions.has(interaction.id)) insertEdge.run(projectId, interaction.pageId, interaction.id, "TRIGGERS");
    }
  });
}

function maxDepthOf(node: IRNode): number {
  return node.children.length === 0 ? 0 : 1 + Math.max(...node.children.map(maxDepthOf));
}

function countNodes(node: IRNode): number {
  return 1 + node.children.reduce((sum, c) => sum + countNodes(c), 0);
}

function prunedMarker(id: string, count: number): IRNode {
  return { id: `${id}#pruned`, tag: "#pruned", attrs: {}, cls: [], text: `${count} nodes pruned`, children: [] };
}

// Breadth-first keep: any node reached at/after `maxDepth` collapses to a marker, unless it
// (or an ancestor) is on the path to a focus id, which is always kept in full.
function truncateAtDepth(node: IRNode, depth: number, maxDepth: number, protectedIds: Set<string>): IRNode {
  if (depth >= maxDepth && node.children.length > 0 && !protectedIds.has(node.id)) {
    return { ...node, children: [prunedMarker(node.id, countNodes(node) - 1)] };
  }
  return { ...node, children: node.children.map((c) => truncateAtDepth(c, depth + 1, maxDepth, protectedIds)) };
}

function focusPathIds(root: IRNode, focusIds: string[]): Set<string> {
  const protectedIds = new Set<string>();
  const findPath = (node: IRNode, path: string[], target: string): string[] | undefined => {
    const next = [...path, node.id];
    if (node.id === target) return next;
    for (const child of node.children) {
      const found = findPath(child, next, target);
      if (found) return found;
    }
    return undefined;
  };
  for (const id of focusIds) findPath(root, [], id)?.forEach((n) => protectedIds.add(n));
  return protectedIds;
}

// Prunes the deepest children first (never below a focus-id path) until `fits`, starting at
// full depth and stepping the depth cap down; returns the smallest depth-0 truncation if that
// still doesn't fit rather than throwing — contextForFix degrades, it never blocks the fix loop.
function pruneToBudget(root: IRNode, protectedIds: Set<string>, fits: (candidate: IRNode) => boolean): IRNode {
  if (fits(root)) return root;
  for (let depth = maxDepthOf(root) - 1; depth >= 0; depth--) {
    const candidate = truncateAtDepth(root, 0, depth, protectedIds);
    if (fits(candidate)) return candidate;
  }
  return truncateAtDepth(root, 0, 0, protectedIds);
}

/**
 * The bounded slice of graph state the AI fix loop sends for one section: its subtree (pruned
 * to `budgetChars`, deepest nodes dropped first, but always keeping the path to any `focusIds`
 * node), the style classes it uses, the tokens/interactions/asset paths linked to it in the
 * graph. Reads only via SQL over nodes/edges — never the in-memory IR.
 */
export function contextForFix(
  db: DatabaseSync,
  projectId: string,
  sectionId: string,
  budgetChars: number,
  focusIds: string[] = [],
): { subtree: IRNode; classes: Record<string, StyleSet>; tokens: Record<string, string>; interactions: Interaction[]; assetPaths: string[] } {
  const row = db.prepare("SELECT data_json FROM nodes WHERE project_id=? AND id=? AND type='Section'").get(projectId, sectionId) as
    | { data_json: string }
    | undefined;
  if (!row) throw new AppError(Codes.GRAPH_NOT_FOUND, `section not found: ${sectionId}`, { projectId, sectionId });
  const section = JSON.parse(row.data_json) as StoredSection;

  const tokenRows = db
    .prepare(
      `SELECT n.key AS name, n.data_json FROM edges e JOIN nodes n ON n.project_id=e.project_id AND n.id=e.dst
       WHERE e.project_id=? AND e.src=? AND e.type='USES_TOKEN' LIMIT ?`,
    )
    .all(projectId, sectionId, CONTEXT_LIMITS.tokens) as { name: string; data_json: string }[];
  const tokens = Object.fromEntries(tokenRows.map((r) => [r.name, JSON.parse(r.data_json) as string]));

  const assetRows = db
    .prepare(
      `SELECT n.id AS id FROM edges e JOIN nodes n ON n.project_id=e.project_id AND n.id=e.dst
       WHERE e.project_id=? AND e.src=? AND e.type='USES_ASSET' LIMIT ?`,
    )
    .all(projectId, sectionId, CONTEXT_LIMITS.assets) as { id: string }[];
  const assetPaths = assetRows.map((r) => r.id.slice("asset:".length));

  const interactionRows = db
    .prepare(
      `SELECT n.data_json FROM edges e JOIN nodes n ON n.project_id=e.project_id AND n.id=e.dst
       WHERE e.project_id=? AND e.src=? AND e.type='TRIGGERS' LIMIT ?`,
    )
    .all(projectId, sectionId, CONTEXT_LIMITS.interactions) as { data_json: string }[];
  const interactions = interactionRows.map((r) => {
    const { pageId: _pageId, ...interaction } = JSON.parse(r.data_json) as Interaction & { pageId: string };
    return interaction;
  });

  const protectedIds = focusPathIds(section.root, focusIds);
  const subtree = pruneToBudget(
    section.root,
    protectedIds,
    (candidate) => JSON.stringify({ subtree: candidate, classes: section.classes, tokens, interactions, assetPaths }).length <= budgetChars,
  );

  return { subtree, classes: section.classes, tokens, interactions, assetPaths };
}

/** Interaction node count by status, grouped by page path; pages with none still list zeros. */
export function coverage(db: DatabaseSync, projectId: string): { page: string; captured: number; failed: number; skipped: number }[] {
  const pages = db.prepare("SELECT id, key AS path FROM nodes WHERE project_id=? AND type='Page' ORDER BY key").all(projectId) as {
    id: string;
    path: string;
  }[];
  const counts = db
    .prepare(
      `SELECT json_extract(data_json,'$.pageId') AS page_id,
              SUM(CASE WHEN json_extract(data_json,'$.status')='captured' THEN 1 ELSE 0 END) AS captured,
              SUM(CASE WHEN json_extract(data_json,'$.status')='failed' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN json_extract(data_json,'$.status')='skipped' THEN 1 ELSE 0 END) AS skipped
       FROM nodes WHERE project_id=? AND type='Interaction' GROUP BY page_id`,
    )
    .all(projectId) as { page_id: string; captured: number; failed: number; skipped: number }[];
  const byPage = new Map(counts.map((c) => [c.page_id, c]));

  return pages.map((p) => {
    const c = byPage.get(p.id);
    return { page: p.path, captured: c?.captured ?? 0, failed: c?.failed ?? 0, skipped: c?.skipped ?? 0 };
  });
}

export function sharedLayouts(db: DatabaseSync, projectId: string): Layout[] {
  const rows = db.prepare("SELECT data_json FROM nodes WHERE project_id=? AND type='Layout' ORDER BY key LIMIT ?").all(projectId, MAX_LAYOUTS) as {
    data_json: string;
  }[];
  return rows.map((r) => JSON.parse(r.data_json) as Layout);
}
