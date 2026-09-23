"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorText } from "@/app/_ui/api";

export type SitemapPage = { url: string; needsAuth: boolean; capturedAt: number | null };

const pathOf = (url: string) => {
  const u = new URL(url);
  return u.pathname + u.search;
};
// Tree by path: sorted by path, indented by segment depth ("/a/b/c" sits under "/a/b").
const depthOf = (path: string) => Math.max(0, path.split("/").filter(Boolean).length - 1);

export function SitemapPicker({ projectId, pages, crawled, draft }: { projectId: string; pages: SitemapPage[]; crawled: boolean; draft: boolean }) {
  const router = useRouter();
  const [selected, setSelected] = useState(() => new Set(pages.map((p) => p.url)));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const sorted = [...pages].sort((a, b) => pathOf(a.url).localeCompare(pathOf(b.url)));
  const allChecked = pages.length > 0 && selected.size === pages.length;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg("");
    try {
      await fn();
    } catch (e) {
      setMsg(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (url: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (!next.delete(url)) next.add(url);
      return next;
    });

  const recrawl = () =>
    run(async () => {
      await api(`/api/projects/${projectId}/crawl`, { method: "POST" });
      router.refresh();
    });

  const start = () =>
    run(async () => {
      await api(`/api/projects/${projectId}/start`, { body: { pages: sorted.filter((p) => selected.has(p.url)).map((p) => p.url) } });
      router.push(`/p/${projectId}`);
    });

  return (
    <div className="stack">
      {msg && <p className="alert" role="alert">{msg}</p>}
      {!crawled && (
        <div className="card row spread">
          <span className="muted">Chưa có sitemap (lần quét trước chưa xong hoặc lỗi).</span>
          <button className="btn" disabled={busy || !draft} onClick={() => void recrawl()}>
            {busy ? "Đang quét…" : "Quét lại"}
          </button>
        </div>
      )}
      {crawled && (
        <section className="card stack">
          <div>
            <label className="row">
              <input type="checkbox" checked={allChecked} disabled={!draft} onChange={() => setSelected(allChecked ? new Set() : new Set(pages.map((p) => p.url)))} />
              Chọn tất cả ({selected.size}/{pages.length})
            </label>
          </div>
          <ul className="plain tree">
            {sorted.map((p) => {
              const path = pathOf(p.url);
              return (
                <li key={p.url} style={{ paddingLeft: depthOf(path) * 20 }}>
                  <label className="row mono">
                    <input type="checkbox" checked={selected.has(p.url)} disabled={!draft} onChange={() => toggle(p.url)} />
                    {path}
                  </label>
                  {p.needsAuth && (
                    <span className="tag" title="Trang này cần đăng nhập">
                      cần đăng nhập
                    </span>
                  )}
                  <span className="muted" style={{ marginLeft: "auto" }}>
                    {p.capturedAt ? `Chụp lúc ${new Date(p.capturedAt * 1000).toLocaleString("vi-VN")}` : "Chưa chụp"}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <div>
        <button className="btn primary" disabled={busy || !draft || selected.size === 0} onClick={() => void start()}>
          Bắt đầu clone
        </button>
      </div>
    </div>
  );
}
