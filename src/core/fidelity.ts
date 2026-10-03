// Pure: capture evidence + IR v2 -> Fidelity items (spec E1 §5). No fs/network/db/Date/random.
// Nothing JS-driven is ever `supported` here: a captured interaction or passing pixel QA is not proof the behavior works.
import type { CaptureNode, PageCapture } from "./capture";
import type { Interaction } from "./interactions";
import { alignChildren, findTrigger, indexById } from "./ir-build";
import { roleIndex, type InteractiveKind, type InteractiveSpec } from "./interactive";
import type { FidelityItem, IRNodeV2, IRV2 } from "./ir-v2";

export const MAX_FIDELITY_ITEMS = 2_000; // per project; the last slot becomes a "… N more" summary
const MAX_NODE_ITEMS = 50; // node-anchored items per page × feature, then one summary item
const MAX_NOTE = 300;
const OVERFLOW = "fidelity-overflow";
// Features derived from captures: re-derived on refresh. Anything else (migration capture-box/component,
// editor style-target) is carried over as recorded.
const ANALYZER = new Set([
  "capture-inventory", "script", "capture-skipped", "iframe", "canvas", "css-media", "pseudo-breakpoint", "pseudo-state",
  "breakpoint-structure", "lazy-load", "asset", "hover", "form", "sticky", "carousel", "menu", "tab", "accordion", "modal",
]);
const FRAME_TAGS = new Set(["iframe", "frame", "object", "embed"]);
const REVEAL = new Set<Interaction["kind"]>(["menu", "tab", "accordion", "modal"]);
const NON_WIDTH_MEDIA = /prefers-|\bprint\b|\bhover\b|\bpointer\b|orientation|resolution|forced-colors|display-mode|aspect-ratio/i;
const RANK: Record<FidelityItem["status"], number> = { unsupported: 0, partial: 1, supported: 2 };

type Status = FidelityItem["status"];
type Anchor = Pick<FidelityItem, "nodeId" | "sourceRef">;
type Index = { nodes: Map<string, IRNodeV2>; behaviors: Map<string, string>; members: Set<string> };

const clip = (s: string) => (s.length > MAX_NOTE ? `${s.slice(0, MAX_NOTE - 1)}…` : s);
// host + path only: query strings / fragments may carry tokens.
function safeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.host}${u.pathname}`.slice(0, 80);
  } catch {
    return "(url)";
  }
}

function indexIR(ir: IRV2): Index {
  const index: Index = { nodes: new Map(), behaviors: new Map(), members: new Set(roleIndex(ir).keys()) };
  const visit = (node: IRNodeV2): void => {
    index.nodes.set(node.id, node);
    if (node.interactive) index.members.add(node.id);
    if (node.behavior && !index.behaviors.has(node.behavior)) index.behaviors.set(node.behavior, node.id);
    node.children.forEach(visit);
  };
  ir.pages.forEach((p) => visit(p.shell));
  ir.sections.forEach((s) => visit(s.root));
  ir.components.forEach((c) => visit(c.root));
  return index;
}

// capture.json is read from disk and may predate a field: every list defaults to empty (no evidence, no item).
function pageFidelity(c: PageCapture, index: Index): FidelityItem[] {
  const { pageId } = c;
  const breakpoints = c.breakpoints ?? [], interactions = c.interactions ?? [], skippedAssets = c.skippedAssets ?? [];
  const media = c.cssom?.media ?? [], stateSelectors = c.cssom?.stateSelectors ?? [];
  const out: FidelityItem[] = [];
  const add = (feature: string, status: Status, note: string, extra: Partial<FidelityItem> = {}) =>
    out.push({ pageId, feature, status, ...extra, note: clip(note) });
  // Capture path ids equal the clone's node ids until an edit deletes the node; sourceRef keeps the anchor.
  const at = (path: string | undefined): Anchor => {
    if (path === undefined) return {};
    const ref = `${pageId}:${path}`;
    return index.nodes.has(ref) ? { nodeId: ref, sourceRef: ref } : { sourceRef: ref };
  };
  const overflow = new Map<string, { status: Status; count: number }>();
  const addNode = (feature: string, status: Status, anchor: Anchor, note: string, breakpoint?: 768 | 375) => {
    const seen = overflow.get(feature) ?? { status: "supported", count: 0 }; // status: worst among the omitted ones
    overflow.set(feature, seen);
    if (++seen.count <= MAX_NODE_ITEMS) add(feature, status, note, { ...anchor, ...(breakpoint && { breakpoint }) });
    else if (RANK[status] < RANK[seen.status]) seen.status = status;
  };

  // One walk of the 1440 DOM (what buildIR clones), aligned with 768/375 exactly like toDraft.
  const dom = (bp: number) => breakpoints.find((b) => b.bp === bp)?.dom;
  const root = dom(1440) ?? breakpoints[0]?.dom;
  const paths = new Map<CaptureNode, string>();
  const shots = new Set((c.dynamic ?? []).map((d) => d.order));
  let canvasOrder = 0;
  let frames = 0;
  const visit = (node: CaptureNode, path: string, n768: CaptureNode | undefined, n375: CaptureNode | undefined): void => {
    paths.set(node, path);
    if (node.tag === "#text" || node.tag === "head") return;
    if (FRAME_TAGS.has(node.tag)) {
      frames++;
      addNode("iframe", "partial", at(path), node.children.length
        ? "Iframe cùng origin: nội dung chỉ được chụp tĩnh, script trong iframe không chạy"
        : "Iframe khác origin: clone trỏ tới trang gốc, nội dung không được clone");
    }
    if (node.attrs["data-dynamic"] === "canvas") {
      const shot = shots.has(canvasOrder++);
      addNode("canvas", shot ? "partial" : "unsupported", at(path), shot
        ? "Canvas chỉ là ảnh tĩnh chụp lúc capture, không vẽ lại"
        : "Canvas không chụp được (ẩn, lỗi chụp hoặc vượt giới hạn 20)");
    }
    const kids: ((CaptureNode | undefined)[] | undefined)[] = [];
    for (const [bp, other] of [[768, n768], [375, n375]] as const) {
      const aligned = alignChildren(node, other);
      kids.push(aligned?.kids);
      if (!other) continue; // missing breakpoint (capture-box) or an ancestor already diverged (reported there)
      if (other.tag !== node.tag) {
        addNode("breakpoint-structure", "partial", at(path), `Phần tử ở ${bp} khác 1440 (${other.tag.slice(0, 20)}); style ${bp} không được clone`, bp);
        continue;
      }
      if (JSON.stringify(other.pseudo ?? {}) !== JSON.stringify(node.pseudo ?? {})) {
        addNode("pseudo-breakpoint", "partial", at(path), `::before/::after ở ${bp} khác 1440; clone chỉ giữ bản 1440`, bp);
      }
      if (aligned?.keyed) {
        addNode("breakpoint-structure", "partial", at(path), `Số phần tử con ở ${bp} khác 1440; đã ghép theo khoá slide, phần tử chỉ có ở 1440 bị ẩn ở ${bp}`, bp);
      } else if (other.children.length !== node.children.length) {
        addNode("breakpoint-structure", "partial", at(path), `Số phần tử con ở ${bp} khác 1440; style ${bp} của cây con không được clone`, bp);
      }
    }
    node.children.forEach((child, i) => visit(child, `${path}.${i}`, kids[0]?.[i], kids[1]?.[i]));
  };
  if (root) visit(root, "0", root === dom(1440) ? dom(768) : undefined, root === dom(1440) ? dom(375) : undefined);

  const inv = c.inventory;
  if (!inv) {
    add("capture-inventory", "partial", "Capture cũ: chưa đủ dữ liệu capture để xác nhận script, iframe, canvas và phần bị bỏ khi quét");
  } else {
    if (inv.scripts > 0) add("script", "unsupported", `${inv.scripts} nguồn JS (script / inline on*) không chạy trong clone; component có cấu trúc chạy bằng runtime của tool`);
    if (inv.skippedNodes > 0) add("capture-skipped", "unsupported", `${inv.skippedNodes} phần tử template/noscript bị bỏ khi quét`);
    if (inv.iframes > frames) add("iframe", "partial", `${inv.iframes - frames} iframe/embed không có trong snapshot`);
    if (inv.canvases > canvasOrder) add("canvas", "unsupported", `${inv.canvases - canvasOrder} canvas không có trong snapshot`);
  }

  const queries = media.map((text) => /^@media\s*([^{]*)\{/i.exec(text)?.[1]?.trim() ?? "");
  const other = queries.filter((q) => NON_WIDTH_MEDIA.test(q));
  const width = queries.length - other.length;
  if (width > 0) add("css-media", "partial", `${width} @media theo kích thước trong CSS gốc; clone chỉ tái tạo style đã tính ở 1440/768/375, độ rộng khác có thể lệch`);
  if (other.length > 0) {
    const examples = [...new Set(other)].slice(0, 2).map((q) => q.slice(0, 60)).join("; ");
    add("css-media", "unsupported", `${other.length} @media theo điều kiện khác độ rộng (vd. ${examples}) không được tái tạo`);
  }
  const pseudoStates = stateSelectors.filter((s) => /::?(before|after)\b/i.test(s)).length;
  if (pseudoStates > 0) add("pseudo-state", "partial", `${pseudoStates} selector :hover/:focus/:active nhắm ::before/::after; style trạng thái của pseudo-element không được chụp`);

  for (const b of breakpoints) {
    if (b.truncated) add("lazy-load", "partial", "Lazy-load bị cắt (trang cuộn vô hạn hoặc quá dài): nội dung phía dưới có thể thiếu", { breakpoint: b.bp });
  }
  const byCode = new Map<string, string[]>();
  for (const s of skippedAssets) {
    const urls = byCode.get(s.code) ?? [];
    urls.push(s.url);
    byCode.set(s.code, urls);
  }
  for (const [code, urls] of byCode) {
    add("asset", "unsupported", `${urls.length} asset không tải được (${code.slice(0, 40)}), vd. ${urls.slice(0, 3).map(safeUrl).join(", ")}`);
  }

  const byId = root ? indexById(root, new Map()) : new Map<string, CaptureNode>();
  for (const it of interactions) {
    const hit = root && findTrigger(root, byId, it.trigger);
    const anchor = at(hit ? paths.get(hit) : undefined);
    if (it.status !== "captured") {
      addNode(it.kind, "unsupported", anchor, it.status === "failed"
        ? `Tương tác ${it.kind} quét thất bại: hành vi không được clone`
        : `Tương tác ${it.kind} bị bỏ qua (hết thời gian quét): hành vi không được clone`);
      continue;
    }
    const props = Object.keys(it.styleDelta ?? {});
    const listed = props.slice(0, 5).join(", ");
    const node = anchor.nodeId ? index.nodes.get(anchor.nodeId) : undefined;
    if ((it.kind === "carousel" || REVEAL.has(it.kind)) && anchor.nodeId && index.members.has(anchor.nodeId)) continue; // the component item covers it
    if (it.kind === "carousel" || REVEAL.has(it.kind)) {
      const bound = index.behaviors.get(it.id);
      if (!bound) addNode(it.kind, "unsupported", anchor, `Tương tác ${it.kind} không gắn được vào node trong clone`);
      else if (it.kind === "carousel") addNode(it.kind, "partial", { nodeId: bound, sourceRef: anchor.sourceRef ?? bound }, "Carousel chỉ được quét chuyển động; slides/autoplay/pagination không được lưu, runtime chỉ cuộn overflow native");
      else addNode(it.kind, "partial", { nodeId: bound, sourceRef: anchor.sourceRef ?? bound }, `Hành vi ${it.kind} dùng runtime chung toggle/tabs/modal; nội dung hiện ra khi tương tác chưa được dựng lại hay kiểm chứng`);
    } else if (it.kind === "sticky") {
      if (props.length === 0) addNode("sticky", "supported", anchor, "position sticky/fixed giữ bằng CSS đã tính");
      else addNode("sticky", "partial", anchor, `Style thay đổi khi cuộn (${listed}) không được clone`);
    } else if (props.length > 0 && it.kind === "hover") {
      if (node && Object.keys(node.styles.state.hover ?? {}).length > 0) addNode("hover", "partial", anchor, "Hover chỉ tái tạo style của chính phần tử; thay đổi ở phần tử con/pseudo không được chụp");
      else addNode("hover", "unsupported", anchor, `Style hover (${listed}) không có trong clone`);
    } else if (props.length > 0 && it.kind === "form") {
      if (node && Object.keys(node.styles.state.focus ?? {}).length > 0) addNode("form", "partial", anchor, "Style focus có trong clone nhưng chưa được đối chiếu với trang gốc");
      else addNode("form", "unsupported", anchor, `Style focus của form (${listed}) không được clone`);
    }
  }

  for (const [feature, { status, count }] of overflow) {
    if (count > MAX_NODE_ITEMS) add(feature, status, `… ${count - MAX_NODE_ITEMS} node ${feature} khác không được liệt kê`);
  }
  return out;
}

function analyze(captures: PageCapture[], ir: IRV2): FidelityItem[] {
  const index = indexIR(ir);
  const pages = new Set(ir.pages.map((p) => p.id));
  return captures.filter((c) => pages.has(c.pageId)).flatMap((c) => pageFidelity(c, index));
}

// Keeps the most severe items first; the last slot summarizes the rest (never silently truncated).
export function capFidelity(items: FidelityItem[]): FidelityItem[] {
  if (items.length <= MAX_FIDELITY_ITEMS) return items;
  const sorted = [...items].sort((a, b) => RANK[a.status] - RANK[b.status]);
  const rest = sorted.slice(MAX_FIDELITY_ITEMS - 1);
  return [
    ...sorted.slice(0, MAX_FIDELITY_ITEMS - 1),
    { pageId: rest[0]!.pageId, feature: OVERFLOW, status: rest[0]!.status, note: `… ${rest.length} mục khác không được liệt kê (giới hạn ${MAX_FIDELITY_ITEMS} mục/project)` },
  ];
}

export const COMPONENT_FEATURE = "component";
export const COMPONENT_NOTE = "component-note";
export type BehaviorResult = { pageId: string; nodeId: string; kind: InteractiveKind; ok: boolean; reason?: string; embed?: true }; // embed: a video iframe, never lifted (§4)
const KIND_LABEL: Record<InteractiveKind, string> = { carousel: "Carousel", tabs: "Tabs", accordion: "Accordion", modal: "Modal", dropdown: "Dropdown", menu: "Menu", video: "Video" };
const CONFIDENCE_LABEL: Record<InteractiveSpec["confidence"], string> = {
  config: "đọc từ cấu hình thư viện", observed: "quan sát trên trang gốc", guessed: "suy từ cấu trúc", manual: "gắn tay, chưa kiểm chứng",
};

// E2 §7: only a library carousel has a config a re-clone can read (aria/details/native guesses have none)
const LIBRARY = new Set(["swiper", "slick", "splide"]);
const confidenceLabel = (spec: InteractiveSpec) =>
  CONFIDENCE_LABEL[spec.confidence] + (spec.confidence === "guessed" && spec.kind === "carousel" && LIBRARY.has(spec.source) ? " — Clone lại để đọc cấu hình thật" : "");

// E2 §3: one item per component, re-derived from the document on every refresh. A component the user unwrapped keeps
// an unsupported item (from `before`) until its interactive comes back (Undo).
export function componentFidelity(ir: IRV2, before: FidelityItem[]): FidelityItem[] {
  const out: FidelityItem[] = [], live = new Set<string>(), nodes = new Map<string, IRNodeV2>();
  const notes = new Set((ir.fidelity ?? []).concat(before).filter((x) => x.feature === COMPONENT_NOTE && x.status !== "supported").map((x) => x.nodeId));
  const visit = (pageId: string) => (node: IRNodeV2): void => {
    nodes.set(node.id, node);
    const spec = node.interactive;
    if (spec) {
      live.add(node.id);
      const status = spec.confidence === "config" && !notes.has(node.id) ? "supported" : "partial";
      out.push({ pageId, feature: COMPONENT_FEATURE, status, nodeId: node.id, sourceRef: node.id, note: clip(`${KIND_LABEL[spec.kind]} · nguồn ${spec.source} · ${confidenceLabel(spec)}`) });
    }
    node.children.forEach(visit(pageId));
  };
  ir.pages.forEach((p) => visit(p.id)(p.shell));
  ir.sections.forEach((s) => visit(s.pageId)(s.root));
  for (const x of before) {
    if (x.feature !== COMPONENT_FEATURE || !x.nodeId || live.has(x.nodeId) || !nodes.has(x.nodeId)) continue;
    out.push({ pageId: x.pageId, feature: COMPONENT_FEATURE, status: "unsupported", nodeId: x.nodeId, sourceRef: x.sourceRef ?? x.nodeId, note: "Đã bỏ hành vi theo yêu cầu (Bỏ hành vi); giữ HTML tĩnh" });
  }
  return out;
}

// E2 §5 (R5): applied when the Preview reads a fresh qa.json; never stored. A passed check lifts the item to supported
// unless a partial component-note remains (fields still guessed / defaulted) or it is an embed (§4: always partial,
// played by the embedding site): then it stays partial, noted as verified.
export function withBehavior(items: FidelityItem[], results: BehaviorResult[]): FidelityItem[] {
  const byNode = new Map(results.map((r) => [`${r.pageId}|${r.nodeId}`, r]));
  const noted = new Set(items.filter((x) => x.feature === COMPONENT_NOTE && x.status !== "supported").map((x) => `${x.pageId}|${x.nodeId}`));
  return items.map((x): FidelityItem => {
    const key = `${x.pageId}|${x.nodeId}`;
    const r = x.feature === COMPONENT_FEATURE && x.status !== "unsupported" ? byNode.get(key) : undefined;
    if (!r) return x;
    return r.ok ? { ...x, status: noted.has(key) || r.embed ? "partial" : "supported", note: clip(`${x.note} · đã kiểm chứng hành vi trên bản clone`) } : { ...x, status: "partial", note: clip(`${x.note} · QA hành vi không đạt: ${r.reason ?? "không rõ"}`) };
  });
}

export function buildFidelity(captures: PageCapture[], ir: IRV2): FidelityItem[] {
  return capFidelity([...analyze(captures, ir), ...componentFidelity(ir, [])]);
}

// After an edit: capture-derived items are re-derived for the captured pages against the new document; everything
// else is kept. A node deleted from the clone drops only `nodeId` — the item stays, anchored by `sourceRef`.
export function refreshFidelity(before: FidelityItem[], after: IRV2, captures: PageCapture[]): FidelityItem[] {
  const { nodes } = indexIR(after);
  const captured = new Set(captures.map((c) => c.pageId));
  const kept = before
    .filter((x) => x.feature !== OVERFLOW && x.feature !== COMPONENT_FEATURE && !(captured.has(x.pageId) && ANALYZER.has(x.feature)))
    .map((x) => {
      if (x.nodeId === undefined || nodes.has(x.nodeId)) return x;
      const { nodeId, ...rest } = x;
      return { ...rest, sourceRef: x.sourceRef ?? nodeId };
    });
  const seen = new Set<string>();
  const out: FidelityItem[] = [];
  for (const x of [...analyze(captures, after), ...componentFidelity(after, before), ...kept]) {
    const key = JSON.stringify([x.pageId, x.feature, x.status, x.nodeId, x.breakpoint, x.sourceRef, x.note]);
    if (!seen.has(key)) seen.add(key), out.push(x);
  }
  return capFidelity(out);
}

// Editor save (grapes-adapter `skipped`): `#<element id>[:state] [media]` style rules with no IR target become
// unsupported style-target items. `irIdOf` maps the GrapesJS element id to the IR node id (data-ir-id) when known;
// refused attribute entries (`<id> [name]`) are not clone gaps and are ignored.
export function styleTargetFidelity(pageId: string, skipped: string[], irIdOf: (elementId: string) => string | undefined = () => undefined): FidelityItem[] {
  const out: FidelityItem[] = [];
  for (const entry of skipped.slice(0, MAX_FIDELITY_ITEMS)) {
    const m = /^#(\S+?)(?::(\S+))?(?:\s+(.+))?$/.exec(entry);
    if (!m) continue;
    const nodeId = irIdOf(m[1]!);
    const target = `${m[2] ? `:${m[2]}` : ""}${m[3] ? ` @media ${m[3]}` : ""}`.trim();
    out.push({
      pageId, feature: "style-target", status: "unsupported", ...(nodeId && { nodeId, sourceRef: nodeId }),
      note: clip(`Style ${target} không biểu diễn được trong IR (chỉ base, 768, 375 và hover/focus/active ở base); không được lưu`),
    });
  }
  return out;
}
