import { expect, test, vi } from "vitest";
import type { Page } from "playwright";
import { PNG } from "pngjs";
import { generate } from "@/core/gateway";
import { asTools } from "@/core/inspector";
import { estimateTokens, MAX_IMAGE_WIDTH, MAX_IMAGES_B64, MAX_REQUEST_TOKENS } from "@/core/naming";
import { prepareCommands } from "@/core/ir-command";
import type { IRNodeV2, IRV2 } from "@/core/ir-v2";
import { ask, componentContext, focusDiff, parseCommands, type FixCtx } from "@/core/qa-fix";

vi.mock("@/core/gateway", async (orig) => ({ ...(await orig<typeof import("@/core/gateway")>()), generate: vi.fn() }));
vi.mock("@/core/inspector", async (orig) => ({ ...(await orig<typeof import("@/core/inspector")>()), asTools: vi.fn() }));

const allowed = new Set(["s:0", "s:0.1", "s:0.2"]);
const reply = (commands: unknown[]) => JSON.stringify({ commands });
const rejects = (text: string) => expect(() => parseCommands(text, allowed)).toThrow(expect.objectContaining({ code: "AI_BAD_RESPONSE" }));

test("parseCommands: create/move/delete/style commands inside the section parse (optionally fenced); [] is no fix", () => {
  const commands = [
    { op: "setStyle", id: "s:0", target: 768, changes: { color: "red", margin: null } },
    { op: "setText", id: "s:0.2", text: "hi" },
    { op: "setAttribute", id: "s:0.1", name: "alt", value: "x" },
    { op: "createNode", parentId: "s:0", index: 0, draft: { tag: "p", children: [{ tag: "#text", text: "new" }] } },
    { op: "moveNode", id: "s:0.2", parentId: "s:0.1", index: 0 },
    { op: "duplicateNode", id: "s:0.1", parentId: "s:0", index: 1 },
    { op: "deleteNode", id: "s:0.1" },
  ];
  expect(parseCommands(reply(commands), allowed)).toEqual(commands);
  expect(parseCommands("```json\n" + reply(commands) + "\n```", allowed)).toEqual(commands);
  expect(parseCommands(reply([]), allowed)).toEqual([]);
});

test("parseCommands: ids or parents outside the section, E1-excluded ops, bad JSON/shapes and > 50 commands are AI_BAD_RESPONSE", () => {
  expect(() => parseCommands('{"commands":[{"op":"deleteNode","id":"outside"}]}', new Set(["inside"]))).toThrow();
  expect(() => parseCommands('{"commands":[{"op":"replaceSubtree","id":"inside"}]}', new Set(["inside"]))).toThrow();
  rejects(reply([{ op: "setText", id: "other:1", text: "x" }]));
  rejects(reply([{ op: "moveNode", id: "s:0.1", parentId: "other:0", index: 0 }]));
  rejects(reply([{ op: "createNode", parentId: "other:0", index: 0, draft: { tag: "div" } }]));
  rejects(reply([{ op: "duplicateNode", id: "s:0.1", parentId: "other:0", index: 0 }]));
  rejects(reply([{ op: "replaceSubtree", id: "s:0.1", node: { id: "s:0.1", tag: "div", attrs: {}, cls: [], children: [] } }]));
  rejects(reply([{ op: "setBehavior", id: "s:0", behavior: "ix1" }]));
  rejects(reply([{ op: "promoteLayout", sectionIds: ["s"] }])); // not a section-local fix
  rejects(reply([{ op: "setStyle", id: "s:0", target: 1024, changes: { color: "red" } }]));
  rejects(reply([{ op: "setStyle", id: "s:0", target: "base", changes: { color: 1 } }]));
  rejects(JSON.stringify({ ops: [{ op: "setStyle", id: "s:0", style: { color: "red" } }] })); // the old PatchOps reply
  rejects("sure, here you go");
  rejects(reply(Array.from({ length: 51 }, () => ({ op: "deleteNode", id: "s:0.1" }))));
});

test("a fix reply drafting a script (top level, nested or upper-case) parses as a shape but the command core refuses it", () => {
  const node = (id: string, tag: string, children: IRNodeV2[] = []): IRNodeV2 => ({ id, tag, type: "container", attrs: {}, styles: { base: {}, bp: {}, state: {}, pseudo: {} }, children });
  const ir: IRV2 = {
    version: 2, revision: 0, pages: [{ id: "p", path: "/", title: "", meta: {}, sectionIds: ["s"], shell: node("html", "html") }],
    sections: [{ id: "s", pageId: "p", name: "s", role: "main", hash: "h", origin: "capture", root: { ...node("s:0", "div", [{ ...node("s:0.1", "p"), parentId: "s:0" }]) } }],
    layouts: [], components: [], tokens: {}, cssom: { keyframes: [], fontFace: [], vars: {} }, interactions: [], fidelity: [],
  };
  let i = 0;
  for (const draft of [{ tag: "script", children: [{ tag: "#text", text: "alert(1)" }] }, { tag: "div", children: [{ tag: "script" }] }, { tag: "SCRIPT" }]) {
    const commands = parseCommands(reply([{ op: "createNode", parentId: "s:0", index: 0, draft }]), allowed);
    expect(() => prepareCommands(ir, commands, () => `n${++i}`)).toThrow(expect.objectContaining({ code: "IR_PATCH_INVALID", message: expect.stringMatching(/tag not allowed/) }));
  }
});

test("ask: the inspector's tool screenshots go through fitImages too (every request's images <= MAX_IMAGES_B64 (384 KiB) base64, <= 1024 px wide)", async () => {
  const noise = () => {
    const png = new PNG({ width: 800, height: 800 });
    for (let i = 0; i < png.data.length; i++) png.data[i] = i % 4 === 3 ? 255 : Math.floor(Math.random() * 256);
    return PNG.sync.write(png).toString("base64");
  };
  const shots = [noise(), noise(), noise()]; // ~3.4 MB base64 each: three tool screenshots in one round
  vi.mocked(asTools).mockReturnValue({ tools: [], call: async () => ({}), calls: () => 1, takeImages: () => shots });
  const sent: (string[] | undefined)[] = [];
  vi.mocked(generate).mockImplementation(async (_db, opts) => {
    sent.push(opts.images);
    return sent.length === 1 ? { text: "", tokens: 1, toolCalls: [{ name: "screenshot", args: {} }] } : { text: "done", tokens: 1 };
  });
  const ctx = { db: {}, projectId: "p1" } as unknown as FixCtx;
  expect(await ask(ctx, {} as Page, () => [{ role: "user", content: "fix" }], [])).toBe("done");
  const second = sent[1]!;
  expect(second.length).toBeGreaterThan(0);
  expect(second.reduce((n, b) => n + b.length, 0)).toBeLessThanOrEqual(MAX_IMAGES_B64);
  for (const b of second) expect(PNG.sync.read(Buffer.from(b, "base64")).width).toBeLessThanOrEqual(MAX_IMAGE_WIDTH);
});

// Real-run evidence (hardening spec §8): FOCUS_NODES was 59 124 chars (20 nodes x ~45 props, captured + clone).
test("focusDiff: per node only the props where captured != clone; the JSON cut to <= 20 000 chars from the end", () => {
  const props = (n: number, v: (k: number) => string) => Object.fromEntries(Array.from({ length: n }, (_, k) => [`prop-name-${k}`, v(k)]));
  const same = Array.from({ length: 20 }, (_, i) => ({
    id: `s:0.${i}`,
    diffPixels: 1000 - i,
    captured: props(45, (k) => `value-${k}-orig`),
    clone: props(45, (k) => (k < 3 ? `value-${k}-clone` : `value-${k}-orig`)),
  }));
  expect(JSON.stringify(same).length).toBeGreaterThan(55_000);
  const trimmed = focusDiff(same);
  expect(trimmed).toHaveLength(20);
  for (const n of trimmed) {
    expect(Object.keys(n.captured)).toEqual(["prop-name-0", "prop-name-1", "prop-name-2"]);
    expect(n.clone).toEqual({ "prop-name-0": "value-0-clone", "prop-name-1": "value-1-clone", "prop-name-2": "value-2-clone" });
  }
  // every prop differs (and a readStyle failure keeps its error text): cut from the end, order kept
  const all = same.map((n, i) => (i === 1 ? { ...n, clone: "error: readStyle failed" } : { ...n, clone: props(45, (k) => `other-${k}-${"y".repeat(20)}`) }));
  const cut = focusDiff(all);
  expect(JSON.stringify(cut).length).toBeLessThanOrEqual(20_000);
  expect(cut.length).toBeGreaterThan(0);
  expect(cut.map((n) => n.id)).toEqual(all.slice(0, cut.length).map((n) => n.id));
  expect(cut[1]!.clone).toBe("error: readStyle failed");
  expect(JSON.stringify(focusDiff(all, 10_000)).length).toBeLessThanOrEqual(10_000); // the reduced budget
});

// Hardening spec §8: every generate call of the fix loop is estimated (chars/4, base64 included) and shrunk under
// 120k tokens: images first, then the prompt rebuilt at smaller budgets. The later calls carry the tool turns too.
test("ask: every generate call is fitted under MAX_REQUEST_TOKENS (images dropped, then the prompt rebuilt smaller)", async () => {
  vi.mocked(asTools).mockReturnValue({ tools: [], call: async () => ({}), calls: () => 1, takeImages: () => [] });
  const sent: { chars: number; images?: string[]; tokens: number }[] = [];
  vi.mocked(generate).mockReset().mockImplementation(async (_db, opts) => {
    sent.push({ chars: opts.messages[1]!.content.length, images: opts.images, tokens: estimateTokens(opts.messages, opts.images) });
    return sent.length === 1 ? { text: "", tokens: 1, toolCalls: [{ name: "readStyle", args: {} }] } : { text: "done", tokens: 1 };
  });
  const scales: number[] = [];
  const prompt = (scale: number) => (scales.push(scale), [{ role: "system" as const, content: "sys" }, { role: "user" as const, content: "u".repeat(Math.round(600_000 * scale)) }]);
  const ctx = { db: {}, projectId: "p1" } as unknown as FixCtx;
  expect(await ask(ctx, {} as Page, prompt, ["i".repeat(1_245_662)])).toBe("done");
  expect(sent).toHaveLength(2);
  for (const s of sent) {
    expect(s.images).toBeUndefined();
    expect(s.tokens).toBeLessThanOrEqual(MAX_REQUEST_TOKENS);
    expect(s.chars).toBe(300_000); // 150k tokens at full size -> halved once
  }
  expect(scales).toEqual([1, 0.5, 1, 0.5]);
});

test("AI fix: updateComponent only for a component of the section; item / convert / unwrap ops never reach the AI", () => {
  const ok = parseCommands('{"commands":[{"op":"updateComponent","id":"car","patch":{"slidesPerView":{"1440":2}}}]}', new Set(["car", "x"]), new Set(["car"]));
  expect(ok).toEqual([{ op: "updateComponent", id: "car", patch: { slidesPerView: { "1440": 2 } } }]);
  expect(() => parseCommands('{"commands":[{"op":"updateComponent","id":"x","patch":{"speed":1}}]}', new Set(["car", "x"]), new Set(["car"]))).toThrow(/component/);
  for (const op of ["addComponentItem", "removeComponentItem", "moveComponentItem", "convertToComponent", "unwrapComponent", "addCarouselSlide"])
    expect(() => parseCommands(`{"commands":[{"op":"${op}","id":"car","itemId":"s","index":0}]}`, new Set(["car", "s"]), new Set(["car"]))).toThrow();
  const root = { id: "car", tag: "div", type: "container", attrs: {}, styles: { base: {}, bp: {}, state: {}, pseudo: {} }, children: [],
    interactive: { kind: "carousel", source: "swiper", confidence: "config", viewport: "car", track: "car", slides: ["s"], active: 0, autoplay: false, interval: 5000, loop: false, direction: "horizontal", transition: "slide", speed: 300, slidesPerView: { "1440": 1 }, gap: {} } } as const;
  const ctx = componentContext(root as never);
  expect(ctx).toEqual([{ id: "car", kind: "carousel", config: expect.objectContaining({ speed: 300, slidesPerView: { "1440": 1 } }) }]);
  expect(JSON.stringify(ctx)).not.toContain('"slides"');
});
