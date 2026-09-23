// Browser-side calls to the local API. A body is always sent as JSON (the CSRF guard requires it);
// errors surface the server's code + message, with the two "try again later" states in plain words.
const FRIENDLY: Record<string, string> = {
  PROJECT_BUSY: "Dự án đang bận (job, crawl hoặc cửa sổ đăng nhập đang mở) — thử lại sau.",
  QUEUE_FULL: "Hàng đợi đầy — đợi một dự án chạy xong rồi thử lại.",
};

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const hasBody = opts.body !== undefined;
  const res = await fetch(path, {
    method: opts.method ?? (hasBody ? "POST" : "GET"),
    ...(hasBody ? { headers: { "content-type": "application/json" }, body: JSON.stringify(opts.body) } : {}),
  });
  if (res.ok) return (await res.json()) as T;
  const err = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
  throw new Error(FRIENDLY[err.code ?? ""] ?? `${err.code ?? res.status}: ${err.message ?? res.statusText}`);
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
