// E4: one chat turn of the editor's AI. The prompt (§2), the reply parser and command checks (§3) and the turn loop
// (§1, Task 4). Pure but for the injected `generate` / `dryRun`; no I/O of its own.
import { z } from "zod";
import { CHAT_TOOLS, callChatTool, componentList, nodeDetail, outlineText, SCOPE_LIMITS, type ChatBp, type ChatScope } from "./ai-chat-scope";
import type { ChatRow, ChatStatus } from "./chat-store";
import type { Affected } from "./editor-canvas";
import { AppError, Codes } from "./errors";
import type { ChatMessage, GenerateOptions, GenerateResult } from "./gateway";
import { aiPatchable } from "./interactive";
import { COMMAND_LIMITS, type EditorCommand, type NodeDraft } from "./ir-command";
import { fitRequest } from "./naming";

export const CHAT_LIMITS = { textChars: 2000, replyChars: 1000, historyTurns: 6, historyChars: 1000, toolCalls: 5, fixes: 2, generateCalls: 8, requestTokens: 60_000, turnMs: 5 * 60_000, selection: 50, echoChars: 2000 } as const;
export type ChatInput = { scope: ChatScope; bp: ChatBp; pagePath: string; text: string; history: readonly ChatRow[] };
export type ChatTurnResult = {
  status: ChatStatus; reply: string; code?: string; tokens: number; tokensUsed: number; tokenBudget: number;
  user: ChatRow; message: ChatRow; revision: number; createdIds: string[]; canUndo: boolean; canRedo: boolean; affected?: Affected;
};

const targetOf = (bp: ChatBp) => (bp === 1440 ? '"base"' : String(bp));
export const systemPrompt = (bp: ChatBp): string => `You are the AI assistant of a visual web page editor. The user asks for a change in their own words; you answer
with editor commands that the server validates and applies as ONE undoable step.
Reply with JSON only: {"reply": string, "commands": [...]}
- "reply": short, in the user's language, at most ${CHAT_LIMITS.replyChars} characters: what you changed, or the answer to a question.
  If you edit a section marked "dùng chung N trang", say that it changes on every page showing it.
- "commands": at most ${COMMAND_LIMITS.commands}; [] when the user only asks a question or nothing should change. Each one of
{"op":"setStyle","id":string,"target":"base"|768|375|"hover"|"focus"|"active"|"before"|"after","changes":{cssProp:value|null}} (null removes the prop)
{"op":"setText","id":string,"text":string} (only on a "#text" node) | {"op":"setAttribute","id":string,"name":string,"value":string|null}
{"op":"setHidden","id":string,"hidden":boolean} | {"op":"setName","id":string,"name":string}
{"op":"createNode","parentId":string,"index":number,"draft":{"tag":string,"attrs"?:{},"styles"?:{"base"?:{cssProp:value}},"children"?:[draft]}}
(text goes in a {"tag":"#text","text":string} child; at most ${COMMAND_LIMITS.nodes} nodes and ${COMMAND_LIMITS.depth} levels; the server assigns ids)
{"op":"moveNode","id":string,"parentId":string,"index":number} (index counted after the node is taken out)
{"op":"duplicateNode","id":string,"parentId":string,"index":number} | {"op":"deleteNode","id":string}
{"op":"updateComponent"|"updateCarousel","id":string,"patch":{field:value}} — only a component of COMPONENTS, only its listed config fields
{"op":"addComponentItem"|"addCarouselSlide","id":string,"from"?:string,"index":number} | {"op":"removeComponentItem"|"removeCarouselSlide","id":string,"itemId":string}
{"op":"moveComponentItem","id":string,"itemId":string,"index":number}
CSS values are strings ("0.5", "2"), not numbers. updateCarousel, addCarouselSlide and removeCarouselSlide apply only to a carousel.
Rules: every id, parentId, itemId and from is a node of OUTLINE not marked "chỉ đọc"; never delete, move or duplicate a
section root. Style edits go to the breakpoint the user is looking at: target ${targetOf(bp)}, unless they ask for every
screen size ("base"). OUTLINE lines are: id · tag · type · name · "text" · W×H; "… +N con" folds children you can read with
the tools. Before answering you may call readNode, readSubtree and findText (at most ${CHAT_LIMITS.toolCalls} calls in all).`;

const clipTo = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

// E4 §2: system, the last turns (alternating, each <= 1 000 chars), then this request with PAGE / OUTLINE / SELECTED /
// COMPONENTS. `scale` (fitRequest) shrinks OUTLINE, SELECTED and COMPONENTS together.
export function chatMessages(input: ChatInput, scale = 1): ChatMessage[] {
  const { scope, bp } = input;
  const keep = (n: number) => Math.max(1, Math.floor(n * scale));
  const history: ChatMessage[] = input.history.map((m) => ({ role: m.role, content: clipTo(m.text, CHAT_LIMITS.historyChars) }));
  const selected = scope.focus.slice(0, keep(SCOPE_LIMITS.selected)).map((id) => nodeDetail(scope, id, keep(SCOPE_LIMITS.toolChars)));
  const content = [
    `PAGE ${input.pagePath} · breakpoint ${bp} · selection ${scope.focus.length ? scope.focus.join(", ") : "không có (cả trang)"}`,
    `OUTLINE\n${outlineText(scope, bp, keep(SCOPE_LIMITS.outlineChars))}`,
    `SELECTED\n${selected.join("\n") || "[]"}`,
    `COMPONENTS ${JSON.stringify(componentList(scope).slice(0, keep(SCOPE_LIMITS.components)))}`,
    `REQUEST\n${input.text}`,
  ].join("\n\n");
  return [{ role: "system", content: systemPrompt(bp) }, ...history, { role: "user", content }];
}

// A reply the AI gets back with the reason (one of its <= 2 fixes).
export class ChatRefusal extends Error {}

const nodeId = z.string().min(1).max(200);
const index = z.number().int().min(0);
// The model may send a breakpoint as a string ("768") and a CSS number as a number (0.5, 2): both are coerced here,
// nothing else is (true, objects and non-finite numbers stay refused).
const target = z.union([z.enum(["base", "hover", "focus", "active", "before", "after"]), z.literal(768), z.literal(375), z.literal("768").transform((): 768 => 768), z.literal("375").transform((): 375 => 375)]);
const cssValue = z.union([z.string(), z.null(), z.number().finite().transform((n) => String(n))]);
const patch = z.record(z.string(), z.unknown());
const commandSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("setStyle"), id: nodeId, target, changes: z.record(z.string(), cssValue) }),
  z.object({ op: z.literal("setText"), id: nodeId, text: z.string() }),
  z.object({ op: z.literal("setAttribute"), id: nodeId, name: z.string(), value: z.string().nullable() }),
  z.object({ op: z.literal("setHidden"), id: nodeId, hidden: z.boolean() }),
  z.object({ op: z.literal("setName"), id: nodeId, name: z.string() }),
  z.object({ op: z.literal("createNode"), parentId: nodeId, index, draft: z.custom<NodeDraft>((v) => typeof v === "object" && v !== null && !Array.isArray(v)) }),
  z.object({ op: z.literal("moveNode"), id: nodeId, parentId: nodeId, index }),
  z.object({ op: z.literal("duplicateNode"), id: nodeId, parentId: nodeId, index }),
  z.object({ op: z.literal("deleteNode"), id: nodeId }),
  z.object({ op: z.literal("updateComponent"), id: nodeId, patch }),
  z.object({ op: z.literal("updateCarousel"), id: nodeId, patch }),
  z.object({ op: z.literal("addComponentItem"), id: nodeId, from: nodeId.optional(), index }),
  z.object({ op: z.literal("removeComponentItem"), id: nodeId, itemId: nodeId }),
  z.object({ op: z.literal("moveComponentItem"), id: nodeId, itemId: nodeId, index }),
  z.object({ op: z.literal("addCarouselSlide"), id: nodeId, from: nodeId.optional(), index }),
  z.object({ op: z.literal("removeCarouselSlide"), id: nodeId, itemId: nodeId }),
]) satisfies z.ZodType<EditorCommand>;
const replySchema = z.object({ reply: z.string(), commands: z.array(commandSchema).max(COMMAND_LIMITS.commands) });

const STRUCTURE = new Set(["deleteNode", "moveNode", "duplicateNode"]);
const SPEC = new Set(["updateComponent", "updateCarousel"]);
const ITEMS = new Set(["addComponentItem", "removeComponentItem", "moveComponentItem", "addCarouselSlide", "removeCarouselSlide"]);
const REFS = ["id", "parentId", "itemId", "from"] as const;

function check(c: EditorCommand, scope: ChatScope): void {
  const fields = c as unknown as Record<string, unknown>;
  for (const k of REFS) {
    const v = fields[k];
    if (typeof v === "string" && !scope.allowed.has(v)) throw new ChatRefusal(`${c.op}: ${k} ${v.slice(0, 80)} is not an editable node of OUTLINE`);
  }
  const id = typeof fields.id === "string" ? fields.id : undefined;
  if (STRUCTURE.has(c.op) && id !== undefined && scope.roots.includes(id)) throw new ChatRefusal(`${c.op}: ${id} is a section root`);
  if (!SPEC.has(c.op) && !ITEMS.has(c.op)) return;
  const kind = id !== undefined ? scope.components.get(id) : undefined;
  if (!kind) throw new ChatRefusal(`${c.op}: ${id ?? "?"} is not a component of COMPONENTS`);
  if (c.op.includes("Carousel") && kind !== "carousel") throw new ChatRefusal(`${c.op}: ${id} is a ${kind}, not a carousel`);
  if (SPEC.has(c.op)) {
    const field = Object.keys(fields.patch as Record<string, unknown>).find((f) => !aiPatchable(kind).includes(f));
    if (field !== undefined) throw new ChatRefusal(`${c.op}: field ${field.slice(0, 40)} is not editable by the AI`);
  }
}

// E4 §3: the AI's JSON (``` fences tolerated, unknown fields dropped) -> reply (cut to 1 000, R7) + commands, or a
// ChatRefusal naming the first problem.
export function parseChatReply(text: string, scope: ChatScope): { reply: string; commands: EditorCommand[] } {
  const body = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    // prose around the object (constraints review focus 5): take the outermost {...}
    try {
      raw = JSON.parse(body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1));
    } catch {
      throw new ChatRefusal("reply is not JSON");
    }
  }
  const parsed = replySchema.safeParse(raw);
  if (!parsed.success) throw new ChatRefusal(parsed.error.message.slice(0, 500));
  for (const c of parsed.data.commands) check(c, scope);
  return { reply: parsed.data.reply.trim().slice(0, CHAT_LIMITS.replyChars), commands: parsed.data.commands };
}

export type TurnDeps = {
  generate: (opts: Pick<GenerateOptions, "messages" | "tools" | "signal">) => Promise<GenerateResult>;
  dryRun: (commands: EditorCommand[]) => void; // throws AppError IR_PATCH_INVALID when the core refuses the batch
  signal: AbortSignal;
};
export type TurnOutcome = { status: "ok" | "answer" | "refused" | "error" | "cancelled"; reply: string; commands: EditorCommand[]; tokens: number; code?: string };

export const CANCELLED_TEXT = "Đã huỷ.";
const ERRORS: Record<string, string> = {
  BUDGET_EXCEEDED: "Hết ngân sách token của project.",
  AI_BAD_CONFIG: "Chưa cấu hình model vai trò Code hoặc cấu hình sai — mở Cài đặt AI.",
  AI_AUTH: "API key sai hoặc không có quyền — sửa ở Cài đặt AI.",
  AI_QUOTA: "Provider hết credit/quota — đổi provider ở Cài đặt AI.",
  AI_RATE_LIMIT: "Provider đang giới hạn tốc độ — thử lại sau.",
  AI_TOO_LARGE: "Yêu cầu vượt giới hạn context của model — chọn ít phần tử hơn hoặc model lớn hơn.",
};
export const chatErrorText = (code: string): string => ERRORS[code] ?? "AI lỗi hoặc trả lời sai định dạng — thử gửi lại.";

// E4 §1/§3: one message -> at most one batch. Read-only tools (<= 5 calls, then no more offered: R9), the reply parsed
// and dry-run; a refusal goes back to the AI (<= 2 fixes); AI_TOO_LARGE retries once at half the context. <= 8 calls
// (+1 after AI_TOO_LARGE). Never throws for an AI or abort failure: the outcome says what happened.
export async function runChatTurn(input: ChatInput, deps: TurnDeps): Promise<TurnOutcome> {
  let tokens = 0, toolCalls = 0, fixes = 0, scale = 1, calls: number = CHAT_LIMITS.generateCalls, shrunk = false;
  let turns: ChatMessage[] = [];
  const end = (status: TurnOutcome["status"], reply: string, code?: string): TurnOutcome => ({ status, reply, commands: [], tokens, ...(code && { code }) });
  for (let call = 0; call < calls; call++) {
    if (deps.signal.aborted) return end("cancelled", CANCELLED_TEXT);
    const req = fitRequest((s) => [...chatMessages(input, s * scale), ...turns], [], CHAT_LIMITS.requestTokens);
    let res: GenerateResult;
    try {
      res = await deps.generate({ messages: req.messages, ...(toolCalls < CHAT_LIMITS.toolCalls && { tools: CHAT_TOOLS }), signal: deps.signal });
    } catch (e) {
      if (deps.signal.aborted) return end("cancelled", CANCELLED_TEXT);
      if (e instanceof AppError && e.code === Codes.AI_TOO_LARGE && !shrunk) { shrunk = true; scale = 0.5; calls++; continue; }
      const code = e instanceof AppError ? e.code : Codes.AI_BAD_RESPONSE;
      return end("error", chatErrorText(code), code);
    }
    tokens += res.tokens;
    if (res.toolCalls?.length && toolCalls < CHAT_LIMITS.toolCalls) {
      const asked = res.toolCalls.slice(0, CHAT_LIMITS.toolCalls - toolCalls);
      const results = asked.map((tc) => ({ name: tc.name, result: callChatTool(input.scope, input.bp, tc.name, tc.args) }));
      toolCalls += asked.length;
      turns = [...turns, { role: "assistant", content: `${res.text}\nTOOL_CALLS ${JSON.stringify(asked)}`.trim() }, { role: "user", content: `TOOL_RESULTS ${JSON.stringify(results)}` }];
      continue;
    }
    let parsed: { reply: string; commands: EditorCommand[] };
    try {
      parsed = parseChatReply(res.text, input.scope);
      if (parsed.commands.length) deps.dryRun(parsed.commands);
    } catch (e) {
      const why = e instanceof ChatRefusal ? e.message : e instanceof AppError && e.code === Codes.IR_PATCH_INVALID ? e.message.slice(0, 500) : undefined;
      if (why === undefined) throw e;
      if (++fixes > CHAT_LIMITS.fixes) return end("refused", `AI chưa tạo được thay đổi hợp lệ: ${why}`);
      turns = [...turns, { role: "assistant", content: res.text.slice(0, CHAT_LIMITS.echoChars) }, { role: "user", content: `Lệnh bị từ chối: ${why}. Trả lại JSON đã sửa.` }];
      continue;
    }
    if (!parsed.commands.length) return end("answer", parsed.reply || "(AI không trả lời gì)");
    return { status: "ok", reply: parsed.reply || "Đã sửa.", commands: parsed.commands, tokens };
  }
  return end("refused", "AI chưa trả lời xong trong giới hạn số lần gọi.");
}
