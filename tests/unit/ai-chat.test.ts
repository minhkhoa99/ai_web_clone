import { expect, test, vi } from "vitest";
import type { IRNodeV2 } from "@/core/ir-v2";
import type { ChatScope } from "@/core/ai-chat-scope";
import type { ChatRow } from "@/core/chat-store";
import { CHAT_LIMITS, ChatRefusal, chatMessages, parseChatReply, runChatTurn, systemPrompt, type TurnDeps } from "@/core/ai-chat";
import { AppError } from "@/core/errors";
import type { GenerateResult } from "@/core/gateway";

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

test("numeric CSS values become strings and '768'/'375' targets become numbers; other types are still refused", () => {
  const out = parseChatReply(reply([{ op: "setStyle", id: "a", target: "768", changes: { opacity: 0.5, "z-index": 2, color: "red", width: null } }]), scope());
  expect(out.commands).toEqual([{ op: "setStyle", id: "a", target: 768, changes: { opacity: "0.5", "z-index": "2", color: "red", width: null } }]);
  expect(refusal(reply([{ op: "setStyle", id: "a", target: "375", changes: { opacity: true } }]))).not.toBe("accepted");
  expect(refusal(reply([{ op: "setStyle", id: "a", target: "base", changes: { opacity: { x: 1 } } }]))).not.toBe("accepted");
  expect(refusal(reply([{ op: "setStyle", id: "a", target: "999", changes: { opacity: "1" } }]))).not.toBe("accepted");
});

test("system prompt says CSS values are strings and the carousel aliases apply only to a carousel", () => {
  expect(systemPrompt(1440)).toContain("CSS values are strings");
  expect(systemPrompt(1440)).toContain("only to a carousel");
});

const input = () => ({ scope: scope(), bp: 1440 as const, pagePath: "/", text: "đổi màu", history: [] });
const deps = (replies: (GenerateResult | Error)[], dryRun: TurnDeps["dryRun"] = () => {}) => {
  const generate = vi.fn(async (_o: Parameters<TurnDeps["generate"]>[0]) => { const r = replies.shift(); if (!r) throw new Error("no more replies"); if (r instanceof Error) throw r; return r; });
  return { generate, dryRun: vi.fn(dryRun), signal: new AbortController().signal };
};
const text = (t: string, tokens = 10): GenerateResult => ({ text: t, tokens });

test("ok: valid commands pass the dry-run -> status ok with the commands and summed tokens", async () => {
  const d = deps([text(reply([{ op: "setStyle", id: "a", target: "base", changes: { color: "red" } }]), 7)]);
  const out = await runChatTurn(input(), d);
  expect(out).toMatchObject({ status: "ok", reply: "Đã sửa", tokens: 7 });
  expect(out.commands).toHaveLength(1);
  expect(d.dryRun).toHaveBeenCalledOnce();
});

test("answer: [] commands -> no dry-run, status answer", async () => {
  const d = deps([text(reply([], "Nút màu xanh."))]);
  expect(await runChatTurn(input(), d)).toMatchObject({ status: "answer", reply: "Nút màu xanh.", commands: [] });
  expect(d.dryRun).not.toHaveBeenCalled();
});

test("a refusal goes back to the AI (parse or dry-run), at most 2 fixes, then status refused", async () => {
  const bad = text(reply([{ op: "setText", id: "elsewhere", text: "x" }]));
  const good = text(reply([{ op: "setHidden", id: "b", hidden: true }]));
  const d1 = deps([bad, good]);
  expect((await runChatTurn(input(), d1)).status).toBe("ok");
  const second = d1.generate.mock.calls[1]![0].messages.at(-1)!.content;
  expect(second).toMatch(/^Lệnh bị từ chối: .*elsewhere/);
  let n = 0;
  const d2 = deps([good, good, good], () => { n++; throw new AppError("IR_PATCH_INVALID", "css not allowed"); });
  const out = await runChatTurn(input(), d2);
  expect(out.status).toBe("refused");
  expect(out.reply).toMatch(/^AI chưa tạo được thay đổi hợp lệ: css not allowed/);
  expect(n).toBe(3);
  expect(d2.generate).toHaveBeenCalledTimes(3);
});

test("tools: results go back as TOOL_RESULTS; after 5 calls tools are no longer offered (R9)", async () => {
  const call = (k: number): GenerateResult => ({ text: "", tokens: 1, toolCalls: Array.from({ length: k }, () => ({ name: "readNode", args: { id: "a" } })) });
  const d = deps([call(3), call(3), text(reply([]))]);
  const out = await runChatTurn(input(), d);
  expect(out.status).toBe("answer");
  const calls = d.generate.mock.calls.map((c) => c[0]);
  expect(calls[0]!.tools?.map((t) => t.name)).toEqual(["readNode", "readSubtree", "findText"]);
  expect(calls[1]!.messages.at(-1)!.content).toMatch(/^TOOL_RESULTS /);
  expect(calls[2]!.tools).toBeUndefined(); // 3 + 2 (of the second 3) = 5 used
  expect(JSON.parse(calls[2]!.messages.at(-1)!.content.replace(/^TOOL_RESULTS /, ""))).toHaveLength(2);
});

test("errors: budget / config map to status error with code; AI_TOO_LARGE retries once at half context", async () => {
  expect(await runChatTurn(input(), deps([new AppError("BUDGET_EXCEEDED", "x")]))).toMatchObject({ status: "error", code: "BUDGET_EXCEEDED", reply: "Hết ngân sách token của project." });
  expect((await runChatTurn(input(), deps([new AppError("AI_BAD_CONFIG", "no provider")]))).reply).toMatch(/Cài đặt AI/);
  const d = deps([new AppError("AI_TOO_LARGE", "big"), text(reply([]))]);
  expect((await runChatTurn(input(), d)).status).toBe("answer");
  const [first, second] = d.generate.mock.calls.map((c) => JSON.stringify(c[0].messages).length);
  expect(second).toBeLessThanOrEqual(first!);
  expect((await runChatTurn(input(), deps([new AppError("AI_TOO_LARGE", "big"), new AppError("AI_TOO_LARGE", "big")]))).status).toBe("error");
});

test("abort: before a call or during one -> cancelled, no commands", async () => {
  const c = new AbortController();
  c.abort();
  const d = { ...deps([text(reply([]))]), signal: c.signal };
  expect(await runChatTurn(input(), d)).toMatchObject({ status: "cancelled", commands: [] });
  expect(d.generate).not.toHaveBeenCalled();
  const c2 = new AbortController();
  const d2 = { ...deps([]), signal: c2.signal, generate: vi.fn(async (_o: Parameters<TurnDeps["generate"]>[0]): Promise<GenerateResult> => { c2.abort(); throw new Error("aborted"); }) };
  expect((await runChatTurn(input(), d2)).status).toBe("cancelled");
});

test("never more than 8 generate calls", async () => {
  const tool = (): GenerateResult => ({ text: "", tokens: 1, toolCalls: [{ name: "findText", args: { query: "a" } }] });
  const notJson = () => text("không phải JSON");
  const d = deps([tool(), tool(), tool(), tool(), tool(), notJson(), notJson(), notJson(), notJson()]);
  const out = await runChatTurn(input(), d);
  expect(out.status).toBe("refused");
  expect(d.generate.mock.calls.length).toBeLessThanOrEqual(CHAT_LIMITS.generateCalls);
});
