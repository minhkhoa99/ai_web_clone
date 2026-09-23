import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AppError, type Code } from "./errors";
import { encrypt, decrypt } from "./crypto";
import { config } from "./config";

export type ProviderKind = "anthropic" | "openai";
export type Role = "vision" | "code" | "design";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ToolDef {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface ToolCall {
  name: string;
  args: unknown;
}

export interface GenerateOptions {
  role: Role;
  messages: ChatMessage[];
  images?: string[]; // base64 PNG
  tools?: ToolDef[];
  jsonSchema?: { name: string; schema: unknown };
  projectId?: string;
}

export interface GenerateResult {
  text: string;
  toolCalls?: ToolCall[];
  tokens: number;
}

interface ProviderRoles {
  vision?: string;
  code?: string;
  design?: string;
}

export interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

const MAX_RETRIES = 2;
const BASE_DELAY_MS = 500;
const TIMEOUT_MS = 120_000;
const ANTHROPIC_VERSION = "2023-06-01";

type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- pure request/response mapping (no I/O) ----

function splitSystemAndMessages(messages: ChatMessage[]): { system: string; rest: ChatMessage[] } {
  const systemParts: string[] = [];
  const rest: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") systemParts.push(m.content);
    else rest.push(m);
  }
  return { system: systemParts.join("\n\n"), rest };
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: "image/png"; data: string } };

function toAnthropicRequest(baseUrl: string, apiKey: string, opts: GenerateOptions & { model?: string }): ProviderRequest {
  const { system, rest } = splitSystemAndMessages(opts.messages);
  let systemText = system;
  if (opts.jsonSchema) {
    const instruction = `Respond with JSON matching schema "${opts.jsonSchema.name}": ${JSON.stringify(opts.jsonSchema.schema)}`;
    systemText = systemText ? `${systemText}\n\n${instruction}` : instruction;
  }

  const messages: { role: "user" | "assistant"; content: string | AnthropicContentBlock[] }[] = rest.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  }));

  if (opts.images?.length) {
    const lastUserIdx = messages.findLastIndex((m) => m.role === "user");
    if (lastUserIdx >= 0) {
      const original = messages[lastUserIdx]!;
      const text = typeof original.content === "string" ? original.content : "";
      const blocks: AnthropicContentBlock[] = [
        ...opts.images.map((data): AnthropicContentBlock => ({ type: "image", source: { type: "base64", media_type: "image/png", data } })),
        { type: "text", text },
      ];
      messages[lastUserIdx] = { role: "user", content: blocks };
    }
  }

  const body: Record<string, unknown> = { model: opts.model, max_tokens: 4096, messages };
  if (systemText) body.system = systemText;
  if (opts.tools?.length) {
    body.tools = opts.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters ?? { type: "object", properties: {} },
    }));
  }

  return {
    url: `${baseUrl}/messages`,
    headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" },
    body,
  };
}

type OpenAiContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

function toOpenAiRequest(baseUrl: string, apiKey: string, opts: GenerateOptions & { model?: string }): ProviderRequest {
  const messages: { role: string; content: string | OpenAiContentPart[] }[] = opts.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  if (opts.images?.length) {
    const lastUserIdx = messages.findLastIndex((m) => m.role === "user");
    if (lastUserIdx >= 0) {
      const original = messages[lastUserIdx]!;
      const text = typeof original.content === "string" ? original.content : "";
      const parts: OpenAiContentPart[] = [
        { type: "text", text },
        ...opts.images.map((data): OpenAiContentPart => ({ type: "image_url", image_url: { url: `data:image/png;base64,${data}` } })),
      ];
      messages[lastUserIdx] = { role: "user", content: parts };
    }
  }

  const body: Record<string, unknown> = { model: opts.model, messages };
  if (opts.tools?.length) {
    body.tools = opts.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters ?? { type: "object", properties: {} } },
    }));
  }
  if (opts.jsonSchema) {
    body.response_format = { type: "json_schema", json_schema: { name: opts.jsonSchema.name, schema: opts.jsonSchema.schema } };
  }

  return {
    url: `${baseUrl}/chat/completions`,
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body,
  };
}

export function toRequest(kind: ProviderKind, baseUrl: string, apiKey: string, opts: GenerateOptions & { model?: string }): ProviderRequest {
  return kind === "anthropic" ? toAnthropicRequest(baseUrl, apiKey, opts) : toOpenAiRequest(baseUrl, apiKey, opts);
}

// Model-written JSON: a malformed one is a bad reply (the fix round is spent), never an uncaught SyntaxError.
function parseToolArgs(name: string, args: string): unknown {
  try {
    return JSON.parse(args) as unknown;
  } catch {
    throw new AppError("AI_BAD_RESPONSE", `tool call "${name}" arguments are not JSON`, { tool: name });
  }
}

function parseOpenAiResponse(raw: unknown): GenerateResult {
  const r = raw as {
    choices?: { message?: { content?: string | null; tool_calls?: { function: { name: string; arguments: string } }[] } }[];
    usage?: { total_tokens?: number };
  };
  const message = r.choices?.[0]?.message;
  if (!message) throw new AppError("AI_BAD_RESPONSE", "openai response missing choices[0].message", {});
  const text = message.content ?? "";
  const toolCalls = message.tool_calls?.map((tc) => ({ name: tc.function.name, args: parseToolArgs(tc.function.name, tc.function.arguments) }));
  const tokens = r.usage?.total_tokens ?? 0;
  return toolCalls?.length ? { text, toolCalls, tokens } : { text, tokens };
}

function parseAnthropicResponse(raw: unknown): GenerateResult {
  const r = raw as {
    content?: { type: string; text?: string; name?: string; input?: unknown }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  if (!Array.isArray(r.content)) throw new AppError("AI_BAD_RESPONSE", "anthropic response missing content array", {});
  const text = r.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  const toolCalls = r.content.filter((b) => b.type === "tool_use").map((b) => ({ name: b.name ?? "", args: b.input }));
  const tokens = (r.usage?.input_tokens ?? 0) + (r.usage?.output_tokens ?? 0);
  return toolCalls.length ? { text, toolCalls, tokens } : { text, tokens };
}

export function parseResponse(kind: ProviderKind, raw: unknown): GenerateResult {
  return kind === "anthropic" ? parseAnthropicResponse(raw) : parseOpenAiResponse(raw);
}

// ---- I/O: saveProvider, fetchModels, generate ----

export function saveProvider(
  db: DatabaseSync,
  p: { name: string; kind: ProviderKind; baseUrl: string; apiKey: string; roles: ProviderRoles },
): string {
  const id = randomUUID();
  db.prepare("INSERT INTO providers(id,name,kind,base_url,api_key_enc,roles_json) VALUES(?,?,?,?,?,?)").run(
    id,
    p.name,
    p.kind,
    p.baseUrl,
    encrypt(p.apiKey),
    JSON.stringify(p.roles),
  );
  return id;
}

function modelsHeaders(kind: ProviderKind, apiKey: string): Record<string, string> {
  return kind === "anthropic" ? { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION } : { Authorization: `Bearer ${apiKey}` };
}

export async function fetchModels(kind: ProviderKind, baseUrl: string, apiKey: string): Promise<string[]> {
  const url = `${baseUrl}/models`;
  const res = await fetch(url, { headers: modelsHeaders(kind, apiKey), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    const { code } = mapHttpError(res.status);
    throw new AppError(code, `fetchModels failed with status ${res.status}`, { status: res.status, url });
  }
  const raw = (await res.json()) as { data?: { id: string }[] };
  if (!Array.isArray(raw.data)) throw new AppError("AI_BAD_RESPONSE", "unexpected /models response shape", { url });
  return raw.data.map((m) => m.id);
}

function mapHttpError(status: number): { code: Code; retryable: boolean } {
  if (status === 429) return { code: "AI_RATE_LIMIT", retryable: true };
  if (status === 401 || status === 403) return { code: "AI_AUTH", retryable: false };
  if (status >= 400 && status < 500) return { code: "AI_BAD_CONFIG", retryable: false };
  return { code: "AI_BAD_RESPONSE", retryable: true };
}

interface ResolvedProvider {
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKeyEnc: string;
  model: string;
}

function findProviderForRole(db: DatabaseSync, role: Role): ResolvedProvider {
  const rows = db.prepare("SELECT name,kind,base_url,api_key_enc,roles_json FROM providers").all() as {
    name: string;
    kind: ProviderKind;
    base_url: string;
    api_key_enc: string;
    roles_json: string;
  }[];
  for (const row of rows) {
    const roles = JSON.parse(row.roles_json) as ProviderRoles;
    const model = roles[role];
    if (model) return { name: row.name, kind: row.kind, baseUrl: row.base_url, apiKeyEnc: row.api_key_enc, model };
  }
  throw new AppError("AI_BAD_CONFIG", `no provider configured for role "${role}"`, { role });
}

function applyTokenUsage(db: DatabaseSync, projectId: string | undefined, tokens: number): void {
  if (!projectId) return;
  const row = db.prepare("SELECT tokens_used,config_json FROM projects WHERE id=?").get(projectId) as
    | { tokens_used: number; config_json: string }
    | undefined;
  if (!row) return;
  const newTotal = row.tokens_used + tokens;
  db.prepare("UPDATE projects SET tokens_used=? WHERE id=?").run(newTotal, projectId);
  const projectConfig = row.config_json ? (JSON.parse(row.config_json) as { tokenBudget?: number }) : {};
  const budget = projectConfig.tokenBudget ?? config.tokenBudget;
  if (newTotal > budget) {
    throw new AppError("BUDGET_EXCEEDED", `token budget exceeded for project "${projectId}"`, { projectId, tokensUsed: newTotal, budget });
  }
}

export async function generate(db: DatabaseSync, opts: GenerateOptions, sleep: Sleep = defaultSleep): Promise<GenerateResult> {
  const provider = findProviderForRole(db, opts.role);
  const apiKey = decrypt(provider.apiKeyEnc);
  const req = toRequest(provider.kind, provider.baseUrl, apiKey, { ...opts, model: provider.model });

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res: Response;
    try {
      res = await fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body), signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      if (attempt === MAX_RETRIES) {
        throw new AppError("AI_BAD_RESPONSE", "network error calling provider", { provider: provider.name, url: req.url });
      }
      await sleep(BASE_DELAY_MS * 2 ** attempt);
      continue;
    }

    if (!res.ok) {
      const { code, retryable } = mapHttpError(res.status);
      if (!retryable || attempt === MAX_RETRIES) {
        throw new AppError(code, `provider "${provider.name}" returned status ${res.status}`, { status: res.status, provider: provider.name, url: req.url });
      }
      const retryAfterSec = res.status === 429 ? Number(res.headers.get("retry-after")) : NaN;
      const delay = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : BASE_DELAY_MS * 2 ** attempt;
      await sleep(delay);
      continue;
    }

    let raw: unknown;
    try {
      raw = await res.json();
    } catch {
      throw new AppError("AI_BAD_RESPONSE", "unparseable response body", { provider: provider.name, url: req.url });
    }
    const result = parseResponse(provider.kind, raw);
    applyTokenUsage(db, opts.projectId, result.tokens);
    return result;
  }

  // unreachable: the loop above always returns or throws
  throw new AppError("AI_BAD_RESPONSE", "generate failed after retries", { provider: provider.name, url: req.url });
}
