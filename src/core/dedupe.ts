// Pure: no fs/network/db/Date/random. Only node:crypto hashing.
import { createHash } from "node:crypto";

export type Decl = Record<string, string>;

export type StyleSet = {
  base: Decl;
  before?: Decl;
  after?: Decl;
  media?: { "768"?: Decl; "375"?: Decl };
};

export type StyledNode = {
  id: string;
  tag: string;
  attrs: Record<string, string>;
  style: StyleSet;
  children: StyledNode[];
};

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function hash6(s: string): string {
  return sha256Hex(s).slice(0, 6);
}

function sortDecl(decl: Decl): Decl {
  const out: Decl = {};
  for (const key of Object.keys(decl).sort()) out[key] = decl[key] as string;
  return out;
}

function isEmptyDecl(decl: Decl | undefined): boolean {
  return !decl || Object.keys(decl).length === 0;
}

function isEmptyStyle(style: StyleSet): boolean {
  return (
    isEmptyDecl(style.base) &&
    isEmptyDecl(style.before) &&
    isEmptyDecl(style.after) &&
    isEmptyDecl(style.media?.["375"]) &&
    isEmptyDecl(style.media?.["768"])
  );
}

// Sorted keys at every level, empty sub-objects dropped (base always kept).
function canonicalize(style: StyleSet): StyleSet {
  const canon: StyleSet = { base: sortDecl(style.base) };
  if (!isEmptyDecl(style.before)) canon.before = sortDecl(style.before as Decl);
  if (!isEmptyDecl(style.after)) canon.after = sortDecl(style.after as Decl);

  const media: StyleSet["media"] = {};
  if (!isEmptyDecl(style.media?.["375"])) media["375"] = sortDecl(style.media?.["375"] as Decl);
  if (!isEmptyDecl(style.media?.["768"])) media["768"] = sortDecl(style.media?.["768"] as Decl);
  if (Object.keys(media).length > 0) canon.media = media;

  return canon;
}

// Assigns `s-<hash6>` for `key`; on collision with a *different* key, widens
// the hash (hash8, hash10, ...) until unique. Never merges distinct keys.
function assignClassName(key: string, nameToKey: Map<string, string>): string {
  const full = sha256Hex(key);
  let len = 6;
  let candidate = full.slice(0, len);
  while (nameToKey.has(candidate) && nameToKey.get(candidate) !== key) {
    len += 2;
    candidate = full.slice(0, len);
  }
  nameToKey.set(candidate, key);
  return `s-${candidate}`;
}

export function dedupeStyles(roots: StyledNode[]): {
  classMap: Map<string, string[]>;
  classes: Record<string, StyleSet>;
} {
  const classMap = new Map<string, string[]>();
  const classes: Record<string, StyleSet> = {};
  const nameToKey = new Map<string, string>();
  const keyToName = new Map<string, string>();

  function visit(node: StyledNode): void {
    if (node.tag !== "#text" && !isEmptyStyle(node.style)) {
      const canon = canonicalize(node.style);
      const key = JSON.stringify(canon);
      let className = keyToName.get(key);
      if (!className) {
        className = assignClassName(key, nameToKey);
        keyToName.set(key, className);
        classes[className] = canon;
      }
      classMap.set(node.id, [className]);
    }
    for (const child of node.children) visit(child);
  }

  for (const root of roots) visit(root);
  return { classMap, classes };
}

// tag + sorted class tokens, recursively over element children; text and all
// other attrs/styles are ignored, so same structure + different text hashes equal.
function structuralKey(node: StyledNode): string {
  const classTokens = (node.attrs.class ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
  const childKeys = node.children.filter((c) => c.tag !== "#text").map(structuralKey);
  return `${node.tag}[${classTokens}](${childKeys.join(",")})`;
}

export function structuralHash(node: StyledNode): string {
  return hash6(structuralKey(node));
}

export type TokenCategory = "color" | "font" | "size" | "space" | "radius" | "shadow";

const SKIP_VALUES = new Set(["0px", "none", "normal", "transparent", "rgba(0, 0, 0, 0)"]);

function isBorderColor(prop: string): boolean {
  return prop === "border-color" || (prop.startsWith("border-") && prop.endsWith("-color"));
}

function isBorderRadius(prop: string): boolean {
  return prop === "border-radius" || (prop.startsWith("border-") && prop.endsWith("-radius"));
}

function isSpacing(prop: string): boolean {
  return (
    prop === "gap" ||
    prop === "row-gap" ||
    prop === "column-gap" ||
    prop.startsWith("margin-") ||
    prop.startsWith("padding-")
  );
}

export function categoryOf(prop: string): TokenCategory | null {
  if (prop === "color" || prop === "background-color" || prop === "outline-color" || prop === "fill" || prop === "stroke" || isBorderColor(prop)) {
    return "color";
  }
  if (prop === "font-family") return "font";
  if (prop === "font-size") return "size";
  if (isSpacing(prop)) return "space";
  if (isBorderRadius(prop)) return "radius";
  if (prop === "box-shadow") return "shadow";
  return null;
}

export function extractTokens(roots: StyledNode[], minCount = 3): Record<string, string> {
  const counts: Record<TokenCategory, Map<string, number>> = {
    color: new Map(),
    font: new Map(),
    size: new Map(),
    space: new Map(),
    radius: new Map(),
    shadow: new Map(),
  };

  function tally(decl: Decl | undefined): void {
    if (!decl) return;
    for (const [prop, value] of Object.entries(decl)) {
      if (SKIP_VALUES.has(value)) continue;
      const category = categoryOf(prop);
      if (!category) continue;
      const map = counts[category];
      map.set(value, (map.get(value) ?? 0) + 1);
    }
  }

  function visit(node: StyledNode): void {
    if (node.tag !== "#text") {
      tally(node.style.base);
      tally(node.style.before);
      tally(node.style.after);
      tally(node.style.media?.["375"]);
      tally(node.style.media?.["768"]);
    }
    for (const child of node.children) visit(child);
  }

  for (const root of roots) visit(root);

  const tokens: Record<string, string> = {};
  for (const category of Object.keys(counts) as TokenCategory[]) {
    const entries = [...counts[category].entries()].filter(([, count]) => count >= minCount);
    entries.sort(([valueA, countA], [valueB, countB]) => countB - countA || (valueA < valueB ? -1 : valueA > valueB ? 1 : 0));
    entries.forEach(([value], i) => {
      tokens[`--${category}-${i + 1}`] = value;
    });
  }
  return tokens;
}
