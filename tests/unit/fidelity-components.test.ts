import { expect, test } from "vitest";
import { COMPONENT_FEATURE, COMPONENT_NOTE, componentFidelity, refreshFidelity, withBehavior } from "@/core/fidelity";
import type { InteractiveSpec } from "@/core/interactive";
import type { FidelityItem, IRNodeV2, IRV2 } from "@/core/ir-v2";

const n = (id: string, tag: string, children: IRNodeV2[] = [], extra: Partial<IRNodeV2> = {}): IRNodeV2 =>
  ({ id, tag, type: "container", attrs: {}, styles: { base: {}, bp: {}, state: {}, pseudo: {} }, children, ...extra });
const tabs = (confidence: InteractiveSpec["confidence"]): InteractiveSpec => ({ kind: "tabs", source: "aria", confidence, tabs: [{ trigger: "a", panel: "b" }], active: 0 });
const ir = (spec?: InteractiveSpec, fidelity: FidelityItem[] = []): IRV2 => ({
  version: 2, revision: 0,
  pages: [{ id: "p", path: "/", title: "", meta: {}, sectionIds: ["s"], shell: n("html", "html", [n("ph", "#section", [], { attrs: { "data-section": "s" } })]) }],
  sections: [{ id: "s", pageId: "p", name: "s", role: "block", hash: "h", origin: "capture", root: n("r", "div", [n("a", "button"), n("b", "div")], spec ? { interactive: spec } : {}) }],
  layouts: [], components: [], tokens: {}, cssom: { keyframes: [], fontFace: [], vars: {} }, interactions: [], fidelity,
});

test("config -> supported, observed/guessed/manual -> partial; a guessed library carousel asks for a re-clone; a partial note keeps config partial", () => {
  expect(componentFidelity(ir(tabs("config")), [])).toEqual([expect.objectContaining({ feature: COMPONENT_FEATURE, status: "supported", nodeId: "r", sourceRef: "r" })]);
  expect(componentFidelity(ir(tabs("observed")), [])[0]!.status).toBe("partial");
  // the re-clone hint only where a re-clone can read a library config: a guessed swiper/slick/splide carousel
  expect(componentFidelity(ir(tabs("guessed")), [])[0]!.note).not.toContain("Clone lại");
  const car = (source: InteractiveSpec["source"]): InteractiveSpec => ({ kind: "carousel", source, confidence: "guessed", viewport: "a", track: "a", slides: ["b"], active: 0, autoplay: false, interval: 5000, loop: false, direction: "horizontal", transition: "slide", speed: 300, slidesPerView: {}, gap: {} });
  for (const source of ["swiper", "slick", "splide"] as const) expect(componentFidelity(ir(car(source)), [])[0]!.note).toContain("Clone lại để đọc cấu hình thật");
  for (const source of ["scroll-snap", "generic"] as const) expect(componentFidelity(ir(car(source)), [])[0]!.note).not.toContain("Clone lại");
  const note: FidelityItem = { pageId: "p", feature: COMPONENT_NOTE, status: "partial", nodeId: "r", sourceRef: "r", note: "hiệu ứng coverflow không tái tạo" };
  expect(componentFidelity(ir(tabs("config"), [note]), [note])[0]!.status).toBe("partial");
});

test("unwrap: the node keeps an unsupported 'bỏ hành vi theo yêu cầu' item, carried until the interactive comes back", () => {
  const before = componentFidelity(ir(tabs("config")), []);
  const unwrapped = refreshFidelity(before, ir(), []);
  expect(unwrapped.find((x) => x.feature === COMPONENT_FEATURE)).toMatchObject({ status: "unsupported", nodeId: "r", note: expect.stringContaining("bỏ hành vi theo yêu cầu") });
  expect(refreshFidelity(unwrapped, ir(), []).filter((x) => x.feature === COMPONENT_FEATURE)).toHaveLength(1);
  expect(refreshFidelity(unwrapped, ir(tabs("config")), []).find((x) => x.feature === COMPONENT_FEATURE)!.status).toBe("supported");
});

test("withBehavior: a passed check lifts the component item unless a partial note remains; a failed one says why; notes are untouched", () => {
  const bare = componentFidelity(ir(tabs("guessed")), []);
  expect(withBehavior(bare, [{ pageId: "p", nodeId: "r", kind: "tabs", ok: true }]).find((x) => x.feature === COMPONENT_FEATURE)).toMatchObject({ status: "supported", note: expect.stringContaining("đã kiểm chứng") });
  const items = [...bare, { pageId: "p", feature: COMPONENT_NOTE, status: "partial" as const, nodeId: "r", note: "interval suy đoán" }];
  const ok = withBehavior(items, [{ pageId: "p", nodeId: "r", kind: "tabs", ok: true }]);
  // spec §5: fields still noted partial keep the item partial — verified, but not the whole config
  expect(ok.find((x) => x.feature === COMPONENT_FEATURE)).toMatchObject({ status: "partial", note: expect.stringContaining("đã kiểm chứng") });
  expect(ok.find((x) => x.feature === COMPONENT_NOTE)!.status).toBe("partial");
  // a note on another page's node of the same id does not hold this one back
  const elsewhere = [...bare, { pageId: "q", feature: COMPONENT_NOTE, status: "partial" as const, nodeId: "r", note: "x" }];
  expect(withBehavior(elsewhere, [{ pageId: "p", nodeId: "r", kind: "tabs", ok: true }]).find((x) => x.feature === COMPONENT_FEATURE)!.status).toBe("supported");
  const bad = withBehavior(items, [{ pageId: "p", nodeId: "r", kind: "tabs", ok: false, reason: "panel 2 không hiện" }]);
  expect(bad.find((x) => x.feature === COMPONENT_FEATURE)).toMatchObject({ status: "partial", note: expect.stringContaining("panel 2 không hiện") });
});
