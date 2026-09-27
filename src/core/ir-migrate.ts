import { promoteLegacyComponents } from "./ir-component";
import type { PageCapture } from "./capture";
import { AppError, Codes } from "./errors";
import type { LegacyIR } from "./ir-legacy";
import { toV2, type IRV2, type NodeType } from "./ir-v2";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = (message: string): never => { throw new AppError(Codes.IR_PATCH_INVALID, message); };
const cssomValid = (value: unknown): boolean => object(value) && Array.isArray(value.keyframes) && Array.isArray(value.fontFace) && object(value.vars);
const nodeTypes = new Set<NodeType>(["container", "text", "image", "link", "button", "input", "media", "svg", "component-root"]);
const strings = (value: unknown): boolean => object(value) && Object.values(value).every((entry) => typeof entry === "string");
const declarations = (value: unknown): boolean => object(value) && Object.values(value).every(strings);

export function migrateIR(input: unknown, captures: PageCapture[]): IRV2 {
  if (!object(input)) return invalid("IR must be an object");
  if (input.version === 2) {
    if (!Number.isSafeInteger(input.revision) || !Array.isArray(input.pages) || !Array.isArray(input.sections) ||
        !Array.isArray(input.layouts) || !Array.isArray(input.components) || !Array.isArray(input.fidelity) ||
        !object(input.tokens) || !cssomValid(input.cssom) || !Array.isArray(input.interactions)) return invalid("invalid v2 IR structure");
    const seen = new Set<string>();
    const visitV2 = (node: unknown, depth: number, count: { value: number }): void => {
      if (!object(node) || typeof node.id !== "string" || !node.id || typeof node.tag !== "string" ||
          !nodeTypes.has(node.type as NodeType) || !strings(node.attrs) || !object(node.styles) ||
          !strings(node.styles.base) || !declarations(node.styles.bp) || !declarations(node.styles.state) ||
          !declarations(node.styles.pseudo) || !Array.isArray(node.children) ||
          (node.parentId !== undefined && typeof node.parentId !== "string") ||
          (node.name !== undefined && typeof node.name !== "string") ||
          (node.text !== undefined && typeof node.text !== "string") ||
          (node.hidden !== undefined && typeof node.hidden !== "boolean") ||
          (node.behavior !== undefined && typeof node.behavior !== "string")) return invalid("invalid v2 IR node");
      if (++count.value > 500 || depth > 20) return invalid("IR subtree limit exceeded");
      if (seen.has(node.id)) return invalid(`duplicate node id: ${node.id}`);
      seen.add(node.id);
      for (const child of node.children) visitV2(child, depth + 1, count);
    };
    for (const page of input.pages) {
      if (!object(page) || typeof page.id !== "string" || !Array.isArray(page.sectionIds)) return invalid("invalid v2 page");
      visitV2(page.shell, 1, { value: 0 });
    }
    for (const section of input.sections) {
      if (!object(section) || typeof section.id !== "string" || typeof section.pageId !== "string") return invalid("invalid v2 section");
      visitV2(section.root, 1, { value: 0 });
    }
    for (const component of input.components) {
      if (!object(component) || typeof component.id !== "string" || !Array.isArray(component.instanceIds)) return invalid("invalid v2 component");
      visitV2(component.root, 1, { value: 0 });
    }
    return input as IRV2;
  }
  if (input.version !== undefined && input.version !== 1) throw new AppError(Codes.IR_VERSION_UNSUPPORTED, "unsupported IR version");
  if (!Array.isArray(input.pages) || !Array.isArray(input.sections) || !Array.isArray(input.layouts) ||
      !Array.isArray(input.components) || !object(input.classes) || !object(input.tokens) ||
      !cssomValid(input.cssom) || !Array.isArray(input.interactions)) return invalid("invalid IR structure");
  const classes = input.classes;
  const classExists = (name: unknown): boolean => {
    const style = typeof name === "string" ? classes[name] : undefined;
    return object(style) && object(style.base);
  };
  const seen = new Set<string>();
  const visit = (node: unknown, depth: number, count: { value: number }): void => {
    if (!object(node) || typeof node.id !== "string" || !node.id || typeof node.tag !== "string" ||
        !object(node.attrs) || !Array.isArray(node.cls) || !Array.isArray(node.children)) return invalid("invalid IR node");
    if (++count.value > 500 || depth > 20) return invalid("IR subtree limit exceeded");
    if (seen.has(node.id)) return invalid(`duplicate node id: ${node.id}`);
    seen.add(node.id);
    for (const name of node.cls) if (!classExists(name)) return invalid(`missing class: ${String(name)}`);
    if (node.states !== undefined) {
      if (!object(node.states)) return invalid("invalid node states");
      for (const name of Object.values(node.states)) if (name !== undefined && !classExists(name)) return invalid(`missing class: ${String(name)}`);
    }
    for (const child of node.children) visit(child, depth + 1, count);
  };
  for (const page of input.pages) {
    if (!object(page) || typeof page.id !== "string" || !Array.isArray(page.sectionIds)) return invalid("invalid page");
    visit(page.shell, 1, { value: 0 });
  }
  for (const section of input.sections) {
    if (!object(section) || typeof section.id !== "string" || typeof section.pageId !== "string") return invalid("invalid section");
    visit(section.root, 1, { value: 0 });
  }
  return promoteLegacyComponents(toV2(input as LegacyIR, captures), (input as LegacyIR).components);
}
