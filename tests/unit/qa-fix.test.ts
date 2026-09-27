import { expect, test, vi } from "vitest";
import type { Page } from "playwright";
import { PNG } from "pngjs";
import { generate } from "@/core/gateway";
import { asTools } from "@/core/inspector";
import { MAX_IMAGE_WIDTH, MAX_IMAGES_B64 } from "@/core/naming";
import { ask, focusDiff, parseOps, type FixCtx } from "@/core/qa-fix";

vi.mock("@/core/gateway", async (orig) => ({ ...(await orig<typeof import("@/core/gateway")>()), generate: vi.fn() }));
vi.mock("@/core/inspector", async (orig) => ({ ...(await orig<typeof import("@/core/inspector")>()), asTools: vi.fn() }));

const allowed = new Set(["s:0", "s:0.1"]);
const reply = (ops: unknown[]) => JSON.stringify({ ops });
const node = (tag: string, attrs: Record<string, string> = {}, children: unknown[] = []) => ({ id: "s:0.1", tag, attrs, cls: [], children });
const rejects = (text: string) => expect(() => parseOps(text, allowed)).toThrow(expect.objectContaining({ code: "AI_BAD_RESPONSE" }));

test("valid ops (optionally fenced) parse; ids outside the section, bad JSON and bad shapes are AI_BAD_RESPONSE", () => {
  const ops = [
    { op: "setStyle", id: "s:0", style: { color: "red" } },
    { op: "replaceSubtree", id: "s:0.1", node: node("p", { "aria-label": "x", "data-k": "v" }, [{ id: "n1", tag: "#text", attrs: {}, text: "hi", cls: [], children: [] }]) },
  ];
  expect(parseOps(reply(ops), allowed)).toEqual(ops);
  expect(parseOps("```json\n" + reply(ops) + "\n```", allowed)).toEqual(ops);
  rejects(reply([{ op: "setText", id: "other:1", text: "x" }]));
  rejects("sure, here you go");
  rejects(reply([{ op: "setStyle", id: "s:0", style: { color: 1 } }]));
  rejects(reply(Array.from({ length: 51 }, () => ops[0])));
});

test("replaceSubtree/setAttr reject unsafe tags, event handlers and bad attr names", () => {
  for (const tag of ["script", "style", "iframe", "object", "embed", "base", "meta", "link", "#section", "Script", 'img src=x onerror="a"', "x>"]) {
    rejects(reply([{ op: "replaceSubtree", id: "s:0.1", node: node(tag) }]));
  }
  for (const name of ["onclick", "OnLoad", 'x"', "a b", "1a"]) {
    rejects(reply([{ op: "setAttr", id: "s:0", attrs: { [name]: "v" } }]));
    rejects(reply([{ op: "replaceSubtree", id: "s:0.1", node: node("div", { [name]: "v" }) }]));
  }
});

test("replaceSubtree deeper than 20 or larger than 500 nodes is rejected", () => {
  let deep = node("div");
  for (let i = 0; i < 20; i++) deep = node("div", {}, [deep]);
  rejects(reply([{ op: "replaceSubtree", id: "s:0.1", node: deep }]));
  rejects(reply([{ op: "replaceSubtree", id: "s:0.1", node: node("div", {}, Array.from({ length: 500 }, () => node("span"))) }]));
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
  expect(await ask(ctx, {} as Page, [{ role: "user", content: "fix" }], [])).toBe("done");
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
