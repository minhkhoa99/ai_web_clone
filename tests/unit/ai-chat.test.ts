import { expect, test } from "vitest";
import type { IRNodeV2 } from "@/core/ir-v2";
import type { ChatScope } from "@/core/ai-chat-scope";
import type { ChatRow } from "@/core/chat-store";
import { CHAT_LIMITS, ChatRefusal, chatMessages, parseChatReply, systemPrompt } from "@/core/ai-chat";

const node = (id: string, children: IRNodeV2[] = [], extra: Partial<IRNodeV2> = {}): IRNodeV2 => ({ id, tag: "div", type: "container", attrs: {}, children, styles: { base: {}, bp: {}, state: {}, pseudo: {} }, ...extra });
// a hand-made scope: section root "r" > "a", "b"; "instance:1:x:y" is a generated (read-only) node; "car" a carousel
function scope(): ChatScope {
  const car = node("car", [node("s1"), node("s2")], { interactive: { kind: "carousel", source: "manual", confidence: "manual", viewport: "car", track: "car", slides: ["s1", "s2"], active: 0, autoplay: false, interval: 5000, loop: false, direction: "horizontal", transition: "slide", speed: 300, slidesPerView: { "1440": 1 }, gap: { "1440": 0 } } as never });
  const root = node("r", [node("a", [], { tag: "h1", type: "text" }), node("b"), node("instance:1:x:y"), car]);
  const all = new Map<string, IRNodeV2>();
  const parent = new Map<string, string>();
  const visit = (n: IRNodeV2, p?: string) => { all.set(n.id, n); if (p) parent.set(n.id, p); n.children.forEach((c) => visit(c, n.id)); };
  visit(root);
  return {
    pageId: "home", sectionIds: ["S"], roots: ["r"], allowed: new Set(["r", "a", "b", "car", "s1", "s2"]), nodes: all, parent,
    sectionOf: new Map([...all.keys()].map((k) => [k, "S"])), names: new Map([["S", "Hero"]]), shared: new Map([["S", 1]]),
    focus: ["a"], components: new Map([["car", "carousel" as const]]),
  };
}
const reply = (commands: unknown[], text = "Đã sửa") => JSON.stringify({ reply: text, commands });
const refusal = (text: string) => { try { parseChatReply(text, scope()); } catch (e) { if (e instanceof ChatRefusal) return e.message; throw e; } return "accepted"; };

test("accepts every allowed op on in-scope ids; strips unknown fields; tolerates ```json fences", () => {
  const cmds = [
    { op: "setStyle", id: "a", target: 768, changes: { color: "red" }, extra: 1 },
    { op: "setText", id: "a", text: "x" }, { op: "setAttribute", id: "a", name: "title", value: null },
    { op: "setHidden", id: "b", hidden: true }, { op: "setName", id: "b", name: "Khối" },
    { op: "createNode", parentId: "r", index: 0, draft: { tag: "p" } }, { op: "moveNode", id: "b", parentId: "r", index: 0 },
    { op: "duplicateNode", id: "b", parentId: "r", index: 1 }, { op: "deleteNode", id: "b" },
    { op: "updateCarousel", id: "car", patch: { speed: 500 } }, { op: "updateComponent", id: "car", patch: { loop: true } },
    { op: "addCarouselSlide", id: "car", from: "s1", index: 2 }, { op: "removeCarouselSlide", id: "car", itemId: "s2" },
    { op: "addComponentItem", id: "car", index: 0 }, { op: "removeComponentItem", id: "car", itemId: "s1" }, { op: "moveComponentItem", id: "car", itemId: "s1", index: 1 },
  ];
  const out = parseChatReply("```json\n" + reply(cmds) + "\n```", scope());
  expect(out.reply).toBe("Đã sửa");
  expect(out.commands).toHaveLength(cmds.length);
  expect(out.commands[0]).toEqual({ op: "setStyle", id: "a", target: 768, changes: { color: "red" } });
});

test("refuses: not JSON, forbidden ops, out-of-scope / read-only refs, section root structure, non-AI fields, wrong component", () => {
  expect(refusal("xin chào")).toMatch(/not JSON/);
  for (const op of [{ op: "promoteLayout", sectionIds: ["S"] }, { op: "detachComponent", instanceId: "a" }, { op: "resetOverride", instanceId: "a" }, { op: "convertToComponent", id: "b", kind: "tabs", roles: {} }, { op: "unwrapComponent", id: "car" }])
    expect(refusal(reply([op]))).not.toBe("accepted");
  expect(refusal(reply([{ op: "setText", id: "instance:1:x:y", text: "x" }]))).toMatch(/instance:1:x:y/);
  expect(refusal(reply([{ op: "setText", id: "elsewhere", text: "x" }]))).toMatch(/elsewhere/);
  expect(refusal(reply([{ op: "createNode", parentId: "elsewhere", index: 0, draft: { tag: "p" } }]))).toMatch(/parentId/);
  expect(refusal(reply([{ op: "removeCarouselSlide", id: "car", itemId: "elsewhere" }]))).toMatch(/itemId/);
  for (const op of ["deleteNode", "moveNode", "duplicateNode"]) expect(refusal(reply([{ op, id: "r", parentId: "r", index: 0 }]))).toMatch(/section root/);
  expect(refusal(reply([{ op: "updateCarousel", id: "car", patch: { arrows: null } }]))).toMatch(/arrows/);
  expect(refusal(reply([{ op: "updateComponent", id: "b", patch: { speed: 1 } }]))).toMatch(/not a component/);
  expect(refusal(reply(Array.from({ length: 51 }, () => ({ op: "setHidden", id: "b", hidden: true }))))).not.toBe("accepted");
});

test("a long reply is cut to 1 000 chars, not refused (R7); [] commands is a plain answer", () => {
  const out = parseChatReply(reply([], "x".repeat(1500)), scope());
  expect(out.reply).toHaveLength(CHAT_LIMITS.replyChars);
  expect(out.commands).toEqual([]);
});

test("messages: system prompt names the breakpoint target; history alternates and is capped; the user block carries PAGE / OUTLINE / SELECTED / COMPONENTS / REQUEST", () => {
  expect(systemPrompt(1440)).toContain('target "base"');
  expect(systemPrompt(768)).toContain("target 768");
  const row = (seq: number, role: "user" | "assistant", text: string): ChatRow => ({ seq, role, text, pageId: "home", status: role === "user" ? null : "answer", revision: null, commands: 0, tokens: 0, createdAt: 0 });
  const msgs = chatMessages({ scope: scope(), bp: 375, pagePath: "/", text: "đổi màu tiêu đề", history: [row(1, "user", "q".repeat(3000)), row(2, "assistant", "đáp")] }, 1);
  expect(msgs.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  expect(msgs[1]!.content).toHaveLength(CHAT_LIMITS.historyChars);
  const last = msgs.at(-1)!.content;
  for (const k of ["PAGE / · breakpoint 375 · selection a", "OUTLINE", "SELECTED", "COMPONENTS", "REQUEST\nđổi màu tiêu đề"]) expect(last).toContain(k);
  expect(last).toContain('"id":"car"');
  const small = chatMessages({ scope: scope(), bp: 375, pagePath: "/", text: "x", history: [] }, 0.125);
  expect(JSON.stringify(small).length).toBeLessThanOrEqual(JSON.stringify(msgs).length);
});

test("stray prose around the JSON object is tolerated (constraints review focus 5); prose without an object is refused", () => {
  const out = parseChatReply("Dưới đây là kết quả:\n" + reply([{ op: "setHidden", id: "b", hidden: true }]) + "\nHết.", scope());
  expect(out.commands).toEqual([{ op: "setHidden", id: "b", hidden: true }]);
  expect(refusal("không có JSON nào")).toMatch(/not JSON/);
});
