// Pure: capture evidence + IR v2 -> Fidelity items (spec E1 §5). No fs/network/db/Date/random.
// Nothing JS-driven is ever `supported` here: a captured interaction or passing pixel QA is not proof the behavior works.
import type { CaptureNode, PageCapture } from "./capture";
import type { Interaction } from "./interactions";
import { findTrigger, indexById } from "./ir-build";
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
type Index = { nodes: Map<string, IRNodeV2>; behaviors: Map<string, string> };

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
  const index: Index = { nodes: new Map(), behaviors: new Map() };
  const visit = (node: IRNodeV2): void => {
    index.nodes.set(node.id, node);
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
    const kids: (CaptureNode[] | undefined)[] = [];
    for (const [bp, other] of [[768, n768], [375, n375]] as const) {
      kids.push(other?.tag === node.tag && other.children.length === node.children.length ? other.children : undefined);
      if (!other) continue; // missing breakpoint (capture-box) or an ancestor already diverged (reported there)
      if (other.tag !== node.tag) {
        addNode("breakpoint-structure", "partial", at(path), `Phần tử ở ${bp} khác 1440 (${other.tag.slice(0, 20)}); style ${bp} không được clone`, bp);
        continue;
      }
      if (JSON.stringify(other.pseudo ?? {}) !== JSON.stringify(node.pseudo ?? {})) {
        addNode("pseudo-breakpoint", "partial", at(path), `::before/::after ở ${bp} khác 1440; clone chỉ giữ bản 1440`, bp);
      }
      if (other.children.length !== node.children.length) {
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
    if (inv.scripts > 0) add("script", "unsupported", `${inv.scripts} nguồn JS (script / inline on*) không chạy trong clone; chỉ có runtime chung toggle/tabs/modal/carousel`);
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

export function buildFidelity(captures: PageCapture[], ir: IRV2): FidelityItem[] {
  return capFidelity(analyze(captures, ir));
}

// After an edit: capture-derived items are re-derived for the captured pages against the new document; everything
// else is kept. A node deleted from the clone drops only `nodeId` — the item stays, anchored by `sourceRef`.
export function refreshFidelity(before: FidelityItem[], after: IRV2, captures: PageCapture[]): FidelityItem[] {
  const { nodes } = indexIR(after);
  const captured = new Set(captures.map((c) => c.pageId));
  const kept = before
    .filter((x) => x.feature !== OVERFLOW && !(captured.has(x.pageId) && ANALYZER.has(x.feature)))
    .map((x) => {
      if (x.nodeId === undefined || nodes.has(x.nodeId)) return x;
      const { nodeId, ...rest } = x;
      return { ...rest, sourceRef: x.sourceRef ?? nodeId };
    });
  const seen = new Set<string>();
  const out: FidelityItem[] = [];
  for (const x of [...analyze(captures, after), ...kept]) {
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
