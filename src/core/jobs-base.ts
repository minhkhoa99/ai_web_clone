// Job orchestrator support: the frozen project config schema, pageId derivation (both pure) and the
// in-memory per-project event bus behind SSE.
import { z } from "zod";
import { config } from "./config";

// --- config, page ids -----------------------------------------------------------

const selectorsSchema = z.object({ user: z.string().optional(), pass: z.string().optional(), submit: z.string().optional() }).strict();
// .strict(): unknown keys (a password, an API key) are rejected, never frozen into config_json.
export const projectConfigSchema = z
  .object({
    depth: z.number().int().min(0).max(5).default(2),
    maxPages: z.number().int().min(1).max(100).default(20),
    concurrency: z.number().int().min(1).max(5).default(3),
    delayMs: z.number().int().min(0).max(10_000).default(500),
    threshold: z.number().min(0).max(1).default(0.95),
    tokenBudget: z.number().int().positive().default(config.tokenBudget),
    providerId: z.string().optional(),
    auth: z
      .object({ mode: z.enum(["none", "manual", "auto"]).default("none"), selectors: selectorsSchema.optional() })
      .strict()
      .default({ mode: "none" }),
  })
  .strict();
export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export const createSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  mode: z.enum(["single", "crawl"]),
  config: projectConfigSchema,
});

// "/" -> home, "/a/b" -> a-b, "/x.html" -> x; lowercased (case-insensitive file systems), dupes -2, -3 in URL order.
export function pageIdsFor(urls: string[]): string[] {
  const used = new Set<string>();
  return urls.map((url) => {
    const slug =
      new URL(url).pathname
        .replace(/\.html?$/i, "")
        .replace(/[^A-Za-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase() || "home";
    let id = slug;
    for (let n = 2; used.has(id); n++) id = `${slug}-${n}`;
    used.add(id);
    return id;
  });
}

// --- event bus -------------------------------------------------------------------

export type ProjectStatus = "draft" | "running" | "paused" | "interrupted" | "needs_auth" | "failed" | "completed";
export type TaskStatus = "pending" | "running" | "done" | "failed" | "needs_auth";
export type JobEvent =
  | { type: "status"; status: ProjectStatus; reason?: string }
  | { type: "phase"; phase: string }
  | { type: "task"; phase: string; key: string; status: TaskStatus; errorCode?: string; error?: string }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | { type: "needs_auth"; url: string; code: string }
  | { type: "progress"; progress: number };

const listeners = new Map<string, Set<(e: JobEvent) => void>>();

export function subscribe(projectId: string, cb: (e: JobEvent) => void): () => void {
  const set = listeners.get(projectId) ?? new Set();
  listeners.set(projectId, set.add(cb));
  return () => {
    set.delete(cb);
    if (set.size === 0) listeners.delete(projectId);
  };
}

export function emit(projectId: string, e: JobEvent): void {
  for (const cb of listeners.get(projectId) ?? []) {
    try {
      cb(e);
    } catch {
      // a broken subscriber (closed SSE stream) must never break the job
    }
  }
}
