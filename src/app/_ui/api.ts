// Browser-side calls to the local API. A body is always sent as JSON (the CSRF guard requires it);
// errors surface the code's Vietnamese hint (+ the server's message), or the raw code + message for a code without one.
import { hintFor } from "./error-hints";

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const hasBody = opts.body !== undefined;
  const res = await fetch(path, {
    method: opts.method ?? (hasBody ? "POST" : "GET"),
    ...(hasBody ? { headers: { "content-type": "application/json" }, body: JSON.stringify(opts.body) } : {}),
  });
  if (res.ok) return (await res.json()) as T;
  const err = (await res.json().catch(() => ({}))) as { code?: string; message?: string; revision?: number };
  const hint = hintFor(err.code);
  const message = hint ? `${hint}${err.message ? ` (${err.message})` : ""}` : `${err.code ?? res.status}: ${err.message ?? res.statusText}`;
  throw Object.assign(new Error(message), { code: err.code, revision: err.revision }); // revision: a 409 names the current one
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
