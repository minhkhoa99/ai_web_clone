"use client";
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, errorText } from "@/app/_ui/api";
import { StatusPill } from "@/app/_ui/StatusPill";

type Group = "incomplete" | "completed";
type Row = { id: string; url: string; status: string; progress: number; phase: string | null; updatedAt: number; thumbPage: string | null };
type List = { projects: Row[]; total: number; page: number; pageSize: number };

const RESUMABLE = new Set(["paused", "interrupted", "failed", "needs_auth"]);
const openHref = (r: Row) => (r.status === "draft" ? `/p/${r.id}/sitemap` : `/p/${r.id}`);

export function History() {
  const [group, setGroup] = useState<Group>("incomplete");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [list, setList] = useState<List | null>(null);
  const [msg, setMsg] = useState("");

  const load = useCallback(() => {
    const params = new URLSearchParams({ group, page: String(page), ...(q ? { q } : {}) });
    return api<List>(`/api/projects?${params}`).then(setList, (e: unknown) => setMsg(errorText(e)));
  }, [group, q, page]);
  useEffect(() => void load(), [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setMsg("");
    try {
      await fn();
    } catch (e) {
      setMsg(errorText(e));
    }
    await load();
  };

  const remove = (r: Row) => {
    if (!confirm(`Xóa dự án ${r.url}? Toàn bộ workspace (ảnh chụp, output) sẽ bị xóa.`)) return;
    void act(() => api(`/api/projects/${r.id}`, { method: "DELETE" }));
  };

  const submitSearch = (e: FormEvent) => {
    e.preventDefault();
    setPage(1);
    setQ(search.trim());
  };

  const pickGroup = (g: Group) => {
    setGroup(g);
    setPage(1);
  };

  const pages = list ? Math.max(1, Math.ceil(list.total / list.pageSize)) : 1;

  return (
    <div className="stack">
      <div className="row spread">
        <div className="row" role="group" aria-label="Lọc">
          <button className="btn" aria-pressed={group === "incomplete"} onClick={() => pickGroup("incomplete")}>
            Chưa hoàn thành
          </button>
          <button className="btn" aria-pressed={group === "completed"} onClick={() => pickGroup("completed")}>
            Đã hoàn thành
          </button>
        </div>
        <form className="row" onSubmit={submitSearch} role="search">
          <label className="field">
            Tìm URL
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="https://…" />
          </label>
          <button className="btn">Tìm</button>
        </form>
      </div>
      {msg && <p className="alert" role="alert">{msg}</p>}

      <table>
        <thead>
          <tr>
            <th>Trang</th>
            <th>URL</th>
            <th>Trạng thái</th>
            <th>Tiến độ</th>
            <th>Cập nhật</th>
            <th>Thao tác</th>
          </tr>
        </thead>
        <tbody>
          {list?.projects.map((r) => (
            <tr key={r.id}>
              <td>
                {r.thumbPage ? (
                  <img className="thumb" alt="" src={`/api/projects/${r.id}/files/pages/${encodeURIComponent(r.thumbPage)}/shots/1440.png`} />
                ) : (
                  <div className="thumb" aria-hidden />
                )}
              </td>
              <td className="mono">{r.url}</td>
              <td>
                <StatusPill status={r.status} />
              </td>
              <td>
                <div className="row">
                  <div className="bar" role="progressbar" aria-valuenow={r.progress} aria-valuemin={0} aria-valuemax={100} aria-label="Tiến độ">
                    <span style={{ width: `${r.progress}%` }} />
                  </div>
                  <span className="mono">{r.progress}%</span>
                </div>
                <div className="muted mono">{r.phase ?? "—"}</div>
              </td>
              <td className="muted">{new Date(r.updatedAt * 1000).toLocaleString("vi-VN")}</td>
              <td>
                <div className="row">
                  {RESUMABLE.has(r.status) && (
                    <button className="btn" onClick={() => void act(() => api(`/api/projects/${r.id}/resume`, { method: "POST" }))}>
                      Tiếp tục
                    </button>
                  )}
                  {r.status === "running" && (
                    <button className="btn" onClick={() => void act(() => api(`/api/projects/${r.id}/pause`, { method: "POST" }))}>
                      Tạm dừng
                    </button>
                  )}
                  <Link className="btn" href={openHref(r)}>
                    Mở
                  </Link>
                  <Link className="btn" href={`/new?from=${r.id}`}>
                    Clone lại
                  </Link>
                  <button className="btn danger" onClick={() => remove(r)}>
                    Xóa
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {list?.projects.length === 0 && <p className="muted">Không có dự án nào.</p>}

      <nav className="row" aria-label="Phân trang">
        <button className="btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>
          Trước
        </button>
        <span className="muted">
          Trang {page} / {pages} · {list?.total ?? 0} dự án
        </span>
        <button className="btn" disabled={page >= pages} onClick={() => setPage(page + 1)}>
          Sau
        </button>
      </nav>
    </div>
  );
}
