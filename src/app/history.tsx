"use client";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { RESUMABLE_STATUSES } from "@/core/statuses";
import { api, errorText } from "@/app/_ui/api";
import { Badge } from "@/app/_ui/Badge";
import { Banner } from "@/app/_ui/Banner";
import { Button } from "@/app/_ui/Button";
import { Disclosure } from "@/app/_ui/Disclosure";
import { downloadZip } from "@/app/_ui/download";
import { GridTable } from "@/app/_ui/GridTable";
import { IconButton } from "@/app/_ui/IconButton";
import { PageHeader } from "@/app/_ui/PageHeader";
import { ProgressBar } from "@/app/_ui/ProgressBar";
import { RelTime } from "@/app/_ui/RelTime";
import { SearchInput } from "@/app/_ui/SearchInput";
import { SegmentedControl } from "@/app/_ui/SegmentedControl";
import { StatusPill } from "@/app/_ui/StatusPill";
import { UrlChip } from "@/app/_ui/UrlChip";

type Group = "incomplete" | "completed";
type LastError = { code: string | null; message: string; phase: string; key: string };
type Row = {
  id: string;
  url: string;
  mode: "single" | "crawl";
  status: string;
  progress: number;
  phase: string | null;
  createdAt: number;
  updatedAt: number;
  thumbPage: string | null;
  needsCredentials: boolean;
  queued: boolean;
  pageCount: number | null;
  phaseDone: number | null;
  phaseTotal: number | null;
  lastError: LastError | null;
};
type List = { projects: Row[]; total: number; page: number; pageSize: number; counts: { incomplete: number; completed: number } };

const COLUMNS = [
  { key: "source", header: "NGUỒN & XEM TRƯỚC", width: "minmax(0, 5fr)" },
  { key: "status", header: "TRẠNG THÁI", width: "minmax(150px, 1.4fr)" },
  { key: "phase", header: "PHA & TIẾN ĐỘ", width: "minmax(200px, 2.6fr)" },
  { key: "actions", header: "THAO TÁC", width: "196px" },
];

const openHref = (r: Row) => (r.status === "draft" ? `/p/${r.id}/sitemap` : `/p/${r.id}`);

// <= 7 page buttons: 1 … k-1 k k+1 … N.
export function pageWindow(page: number, pages: number): (number | "gap")[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const mid = [page - 1, page, page + 1].filter((p) => p > 1 && p < pages);
  const first = mid[0] ?? 2;
  const last = mid.at(-1) ?? pages - 1;
  return [1, ...(first > 2 ? ["gap" as const] : []), ...mid, ...(last < pages - 1 ? ["gap" as const] : []), pages];
}

function subtitle(r: Row): ReactNode {
  if (r.status === "needs_auth")
    return (
      <span className="text-warn" data-ui="ui_history_needs_auth_status">
        Cần đăng nhập ({r.lastError?.code ?? "AUTH_REQUIRED"}) — mở dự án để đăng nhập
      </span>
    );
  const mode = r.mode === "crawl" ? "Crawl" : "1 trang";
  if (r.pageCount === null)
    return (
      <>
        {mode} · chưa chọn trang · tạo <RelTime at={r.createdAt} />
      </>
    );
  // single mode is always 1 page: "1 trang · 1 trang" would repeat it, so the count only shows when crawling
  return (
    <>
      {mode} · {r.mode === "crawl" && `${r.pageCount} trang · `}bắt đầu <RelTime at={r.createdAt} />
    </>
  );
}

function failedLine(r: Row): ReactNode {
  if (r.status !== "failed") return null;
  if (!r.lastError)
    return (
      <div className="row-error text-danger" data-ui="ui_history_failed_error_log">
        Lỗi — mở dự án để xem log
      </div>
    );
  const e = r.lastError;
  return (
    <div className="row-error" data-ui="ui_history_failed_error_log">
      <span className="text-danger ellipsis">{e.code ? `${e.code}: ${e.message}` : e.message}</span>
      <Disclosure summary="Chi tiết lỗi">
        <p className="mono text-3">
          [{e.phase}] {e.key}
        </p>
        <p className="error-full">{e.message}</p>
      </Disclosure>
    </div>
  );
}

export function History() {
  const [group, setGroup] = useState<Group>("incomplete");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [list, setList] = useState<List | null>(null);
  const [msg, setMsg] = useState("");
  const [downloading, setDownloading] = useState<string | null>(null);
  const [brokenThumbs, setBrokenThumbs] = useState<ReadonlySet<string>>(new Set());

  const load = useCallback(() => {
    const params = new URLSearchParams({ group, page: String(page), ...(q ? { q } : {}) });
    return api<List>(`/api/projects?${params}`).then(
      (l) => {
        // deleting the last row of the last page (or a group/search change) can leave `page` past the new
        // last page — clamp and reload once, instead of showing an empty page that still says "trang N".
        const lastPage = Math.max(1, Math.ceil(l.total / l.pageSize));
        if (page > lastPage) {
          setPage(lastPage);
          return;
        }
        setList(l);
        setMsg("");
      },
      (e: unknown) => setMsg(errorText(e)),
    );
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

  const download = async (r: Row) => {
    setDownloading(r.id);
    setMsg("");
    try {
      await downloadZip(r.id, false);
    } catch (e) {
      setMsg(errorText(e));
    } finally {
      setDownloading(null);
    }
  };

  const pickGroup = (g: Group) => {
    setGroup(g);
    setPage(1);
  };

  const pages = list ? Math.max(1, Math.ceil(list.total / list.pageSize)) : 1;
  const all = list ? list.counts.incomplete + list.counts.completed : 0;
  const from = list && list.total ? (page - 1) * list.pageSize + 1 : 0;
  const to = list ? Math.min(page * list.pageSize, list.total) : 0;

  const cell = (r: Row, key: string): ReactNode => {
    switch (key) {
      case "source":
        return (
          <div className="source-cell">
            {r.thumbPage && !brokenThumbs.has(r.id) ? (
              <img
                className="row-thumb"
                alt=""
                data-ui="ui_history_row_thumb"
                src={`/api/projects/${r.id}/files/pages/${encodeURIComponent(r.thumbPage)}/shots/1440.png`}
                onError={() => setBrokenThumbs((s) => (s.has(r.id) ? s : new Set(s).add(r.id)))}
              />
            ) : (
              <span className="row-thumb" aria-hidden="true" />
            )}
            <div className="source-text">
              <UrlChip url={r.url} openable plain data-ui="ui_history_row_url" />
              <div className="t-body-sm text-2" data-ui="ui_history_row_subtitle">
                {subtitle(r)}
              </div>
              {failedLine(r)}
            </div>
          </div>
        );
      case "status":
        return <StatusPill status={r.status} queued={r.queued} data-ui="ui_history_status_pill" />;
      case "phase":
        return (
          <div className="phase-cell" data-ui="ui_history_progress_bar">
            <div className={`phase-line t-label-md${r.status === "failed" ? " text-danger" : r.status === "interrupted" ? " text-warn" : ""}`}>
              <span>
                {r.status === "completed" ? "done" : (r.phase ?? "—")}
                {r.status !== "completed" && r.phaseTotal ? ` ${r.phaseDone}/${r.phaseTotal}` : ""}
              </span>
              <span>{r.status === "completed" ? "xong" : `${r.progress}%`}</span>
            </div>
            <ProgressBar value={r.progress} status={r.status} label="Tiến độ" />
            <div className="t-body-sm text-3">
              Cập nhật <RelTime at={r.updatedAt} />
            </div>
          </div>
        );
      default:
        return (
          <div className="row-actions" data-ui="ui_history_row_actions">
            {r.status === "running" && (
              <IconButton data-ui="ui_history_pause_button" icon="pause" label="Tạm dừng" onClick={() => void act(() => api(`/api/projects/${r.id}/pause`, { method: "POST" }))} />
            )}
            {RESUMABLE_STATUSES.includes(r.status) &&
              (r.needsCredentials || r.status === "needs_auth" ? (
                // the progress screen asks for the account / shows the login banner before resuming
                <IconButton data-ui="ui_history_resume_button" icon="play_arrow" label="Tiếp tục" tone={r.status === "interrupted" ? "warn" : "default"} href={`/p/${r.id}`} />
              ) : (
                <IconButton
                  data-ui="ui_history_resume_button"
                  icon="play_arrow"
                  label="Tiếp tục"
                  tone={r.status === "interrupted" ? "warn" : "default"}
                  onClick={() => void act(() => api(`/api/projects/${r.id}/resume`, { method: "POST" }))}
                />
              ))}
            <IconButton data-ui="ui_history_open_button" icon="visibility" label="Mở" href={openHref(r)} />
            <IconButton data-ui="ui_history_reclone_button" icon="replay" label="Clone lại" href={`/new?from=${r.id}`} />
            {r.status === "completed" && (
              <IconButton data-ui="ui_history_download_export" icon="download" label="Tải ZIP" disabled={downloading === r.id} onClick={() => void download(r)} />
            )}
            <IconButton data-ui="ui_history_delete_button" icon="delete" label="Xóa" tone="danger" onClick={() => remove(r)} />
          </div>
        );
    }
  };

  return (
    <>
      <PageHeader data-ui="ui_history_page_header" crumbs={[{ label: "Lịch sử" }]} title="Lịch sử dự án" meta={list && <Badge>{all} dự án</Badge>} />
      <div className="toolbar">
        <SegmentedControl
          data-ui="ui_history_status_tabs"
          semantics="tabs"
          label="Nhóm dự án"
          value={group}
          onChange={pickGroup}
          options={[
            { value: "incomplete", label: "Chưa hoàn thành", count: list?.counts.incomplete },
            { value: "completed", label: "Đã hoàn thành", count: list?.counts.completed },
          ]}
        />
        <div className="toolbar-end">
          <SearchInput
            data-ui="ui_history_url_search"
            label="Tìm theo URL"
            placeholder="Tìm theo URL…"
            value={search}
            onChange={setSearch}
            onSubmit={() => {
              setPage(1);
              setQ(search.trim());
            }}
          />
          <IconButton data-ui="ui_history_refresh" icon="refresh" label="Tải lại" onClick={() => void load()} />
        </div>
      </div>
      {msg && (
        <Banner tone="danger" icon="error">
          {msg}
        </Banner>
      )}
      <GridTable
        data-ui="ui_history_job_rows"
        label="Dự án"
        columns={COLUMNS}
        rows={list?.projects ?? []}
        rowKey={(r) => r.id}
        renderCell={cell}
        rowTone={(r) => (r.status === "needs_auth" ? "warn" : undefined)}
        empty={
          list && (
            <div className="table-empty" data-ui="ui_history_empty">
              <p>Không có dự án nào.</p>
              <Button variant="primary" icon="add" href="/new">
                Clone mới
              </Button>
            </div>
          )
        }
      />
      <nav className="pagination" aria-label="Phân trang" data-ui="ui_history_pagination">
        <span className="t-label-md text-2">
          Hiển thị {from}–{to} / {list?.total ?? 0} dự án
        </span>
        <div className="row">
          <Button disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Trước
          </Button>
          {pageWindow(page, pages).map((p, i) =>
            p === "gap" ? (
              <span key={`gap-${i}`} className="text-3">
                …
              </span>
            ) : (
              <button key={p} type="button" className="page-num" aria-current={p === page ? "page" : undefined} onClick={() => setPage(p)}>
                {p}
              </button>
            ),
          )}
          <Button disabled={page >= pages} onClick={() => setPage(page + 1)}>
            Sau
          </Button>
        </div>
      </nav>
    </>
  );
}
