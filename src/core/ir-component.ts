import { AppError, Codes } from "./errors";
import type { LegacyComponent } from "./ir-legacy";
import type { IRNodeV2, IRV2 } from "./ir-v2";
import { MAX_CAPTURE_NODES, MAX_TREE_DEPTH } from "./limit";

const fail = (message: string): never => { throw new AppError(Codes.IR_PATCH_INVALID, message); };
const roots = (ir: IRV2) => [...ir.sections.map(s => s.root), ...ir.pages.map(p => p.shell)];
function indexTrees(trees: IRNodeV2[]): Map<string, IRNodeV2> {
  const index = new Map<string, IRNodeV2>();
  for (const root of trees) {
    let count = 0;
    const visit = (node: IRNodeV2, depth: number): void => {
      if (++count > MAX_CAPTURE_NODES || depth > MAX_TREE_DEPTH) fail("IR page limit exceeded");
      if (index.has(node.id)) fail(`duplicate or cyclic node: ${node.id}`);
      index.set(node.id, node);
      for (const child of node.children) visit(child, depth + 1);
    };
    visit(root, 1);
  }
  return index;
}
const fields = ["tag", "type", "name", "text", "hidden", "behavior"] as const;
const maps = (node: IRNodeV2): Record<string, Record<string, string>> => ({
  attrs: node.attrs, "styles.base": node.styles.base,
  ...Object.fromEntries((["bp", "state", "pseudo"] as const).flatMap(kind => Object.entries(node.styles[kind]).map(([key, value]) => [`styles.${kind}.${key}`, value]))),
});
function differences(main: IRNodeV2, instance: IRNodeV2): string[] {
  const paths: string[] = fields.filter(key => main[key] !== instance[key]);
  const a = maps(main), b = maps(instance);
  for (const prefix of new Set([...Object.keys(a), ...Object.keys(b)])) {
    for (const key of new Set([...Object.keys(a[prefix] ?? {}), ...Object.keys(b[prefix] ?? {})])) {
      if (a[prefix]?.[key] !== b[prefix]?.[key]) paths.push(`${prefix}.${key}`);
    }
  }
  return paths;
}
function overlay(out: IRNodeV2, instance: IRNodeV2, path: string): void {
  if (path === "children") return;
  if (fields.includes(path as typeof fields[number])) {
    const key = path as typeof fields[number];
    Object.assign(out, { [key]: instance[key] });
    if (instance[key] === undefined) delete out[key];
    return;
  }
  const match = /^(attrs|styles\.base|styles\.bp\.(?:768|375)|styles\.state\.(?:hover|focus|active)|styles\.pseudo\.(?:before|after))\.(.+)$/.exec(path);
  if (!match || ["__proto__", "constructor", "prototype"].includes(match[2]!)) fail(`invalid component override: ${path}`);
  const prefix = match![1]!, key = match![2]!;
  let target = maps(out)[prefix];
  if (!target) {
    const [, kind, slot] = prefix.split(".");
    const group = out.styles[kind as "bp" | "state" | "pseudo"] as Record<string, Record<string, string>>;
    target = group[slot!] = {};
  }
  const value = maps(instance)[prefix]?.[key];
  if (value === undefined) delete target[key]; else Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

export function promoteLegacyComponents(ir: IRV2, groups: LegacyComponent[]): IRV2 {
  const result = structuredClone(ir), nodes = indexTrees(roots(result));
  const taken = new Set([...nodes.keys(), ...indexTrees(result.components.map(c => c.root)).keys()]);
  for (const group of groups) {
    if (result.components.some(c => c.id === group.id)) continue;
    const instances = group.instanceIds.map(id => nodes.get(id));
    const first = instances[0];
    const matches = (a: IRNodeV2, b: IRNodeV2): boolean => !b.component && a.tag === b.tag && a.children.length === b.children.length && a.children.every((child, i) => matches(child, b.children[i]!));
    const selected = new Set<string>();
    const overlaps = (n: IRNodeV2): boolean => { if (selected.has(n.id)) return true; selected.add(n.id); return n.children.some(overlaps); };
    if (!first || instances.length < 2 || instances.some(n => !n || !matches(first, n) || overlaps(n))) {
      for (const page of result.pages) result.fidelity.push({ pageId: page.id, feature: "component", status: "partial", sourceRef: group.id, note: "Legacy component trees could not be matched confidently" });
      continue;
    }
    const main = structuredClone(first);
    const assign = (n: IRNodeV2, parentId?: string): void => {
      const seed = `main:${group.id}:${n.id}`;
      let id = seed, suffix = 0;
      while (taken.has(id)) id = `${seed}:${++suffix}`;
      taken.add(id); n.id = id;
      if (parentId) n.parentId = parentId; else delete n.parentId;
      n.component = { id: group.id, role: "main" };
      n.children.forEach(child => assign(child, id));
    };
    assign(main);
    const link = (source: IRNodeV2, n: IRNodeV2): void => {
      n.component = { id: group.id, role: "instance", sourceId: source.id, overrides: differences(source, n) };
      n.children.forEach((child, i) => link(source.children[i]!, child));
    };
    instances.forEach(n => link(main, n!));
    result.components.push({ id: group.id, root: main, instanceIds: [...group.instanceIds] });
  }
  return result;
}

export function resolveComponents(ir: IRV2): IRV2 {
  const reserved = new Set(indexTrees([...roots(ir), ...ir.components.map(c => c.root)]).keys());
  const sources = new Map<string, Map<string, IRNodeV2>>();
  for (const component of ir.components) {
    if (sources.has(component.id)) fail(`duplicate component: ${component.id}`);
    sources.set(component.id, indexTrees([component.root]));
  }
  const resolve = (node: IRNodeV2, active: Set<string>, depth: number, budget: { count: number }, counterparts?: Map<string, IRNodeV2>, instanceRoot?: string): IRNodeV2 => {
    if (++budget.count > MAX_CAPTURE_NODES || depth > MAX_TREE_DEPTH) fail("IR page limit exceeded");
    const ref = node.component;
    if (ref?.role !== "instance") return { ...structuredClone({ ...node, children: [] }), children: node.children.map(n => resolve(n, active, depth + 1, budget)) };
    const source = sources.get(ref.id)?.get(ref.sourceId ?? "");
    if (!source) fail(`missing component source for instance ${node.id}`);
    if (active.has(source!.id)) fail(`component cycle at instance ${node.id}`);
    const next = new Set(active).add(source!.id);
    if (!counterparts) {
      counterparts = new Map(); instanceRoot = node.id;
      for (const n of indexTrees([node]).values()) {
        if (n.component?.role !== "instance" || n.component.id !== ref.id) continue;
        if (!sources.get(ref.id)!.has(n.component.sourceId ?? "") && n.component.overrides?.length) fail(`removed main node has overrides in instance ${n.id}`);
        if (n.component.sourceId) {
          if (counterparts.has(n.component.sourceId)) fail(`ambiguous source in instance ${node.id}`);
          counterparts.set(n.component.sourceId, n);
        }
      }
    }
    const base = source!.component?.role === "instance" ? resolve(source!, next, depth, { count: 0 }) : source!;
    const out = structuredClone({ ...base, children: [] as IRNodeV2[] });
    out.id = node.id; out.component = structuredClone(ref);
    if (node.parentId === undefined) delete out.parentId; else out.parentId = node.parentId;
    if (node.box === undefined) delete out.box; else out.box = structuredClone(node.box);
    for (const path of ref.overrides ?? []) overlay(out, node, path);
    const children = ref.overrides?.includes("children") ? node.children : base.children.map(child => {
      const existing = counterparts!.get(child.id);
      if (existing) return existing;
      const id = `instance:${instanceRoot!.length}:${instanceRoot}:${child.id}`;
      if (reserved.has(id)) fail(`generated instance ID collision: ${id}`);
      reserved.add(id);
      return { ...child, id, component: { id: ref.id, role: "instance" as const, sourceId: child.id, overrides: [] } };
    });
    out.children = children.map(child => ({ ...resolve(child, next, depth + 1, budget, child.component?.id === ref.id ? counterparts : undefined, instanceRoot), parentId: out.id }));
    return out;
  };
  const materialize = (n: IRNodeV2) => resolve(n, new Set(), 1, { count: 0 });
  return { ...ir, sections: ir.sections.map(s => ({ ...s, root: materialize(s.root) })), pages: ir.pages.map(p => ({ ...p, shell: materialize(p.shell) })) };
}

export function resetOverride(ir: IRV2, instanceId: string, path?: string): IRV2 {
  const result = structuredClone(ir), node = indexTrees(roots(result)).get(instanceId);
  if (node?.component?.role !== "instance") fail(`not a component instance: ${instanceId}`);
  if (path === undefined) {
    for (const child of indexTrees([node!]).values()) if (child.component?.id === node!.component!.id) child.component.overrides = [];
  } else node!.component!.overrides = (node!.component!.overrides ?? []).filter(p => p !== path);
  return resolveComponents(result);
}

export function detachComponent(ir: IRV2, instanceId: string): IRV2 {
  const result = structuredClone(resolveComponents(ir)), nodes = indexTrees(roots(result)), node = nodes.get(instanceId);
  if (node?.component?.role !== "instance") fail(`not a component instance: ${instanceId}`);
  const parent = nodes.get(node!.parentId ?? "");
  if (parent?.component?.role === "instance") parent.component.overrides = [...new Set([...(parent.component.overrides ?? []), "children"])];
  const detached = new Set(indexTrees([node!]).keys());
  for (const n of indexTrees([node!]).values()) delete n.component;
  for (const component of result.components) component.instanceIds = component.instanceIds.filter(id => !detached.has(id));
  return result;
}
