"use client";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import type { CrawlPage } from "@/core/crawl";
import { estimateRun, type HistoryRates } from "@/core/estimate";
import { api, errorText } from "@/app/_ui/api";
import { Badge } from "@/app/_ui/Badge";
import { Banner } from "@/app/_ui/Banner";
import { Button } from "@/app/_ui/Button";
import { Card } from "@/app/_ui/Card";
import { GridTable } from "@/app/_ui/GridTable";
import { Icon } from "@/app/_ui/Icon";
import { IconButton } from "@/app/_ui/IconButton";
import { RelTime } from "@/app/_ui/RelTime";
import { SearchInput } from "@/app/_ui/SearchInput";
import { SegmentedControl } from "@/app/_ui/SegmentedControl";
import { fmtMinutes, fmtTokens } from "@/app/_ui/format";
import { importSessionFile } from "../session-tools";
import { buildRouteTree, filterTree, httpLabel, parentKeys, pathOf, selectionState, visibleRows, type RouteRow } from "./route-tree";

export type SitemapPage = CrawlPage & { capturedAt: number | null };
type Filter = "all" | "public" | "auth" | "recent";
type Props = {
  projectId: string;
  pages: SitemapPage[];
  crawled: boolean;
  draft: boolean;
  rates: HistoryRates;
  tokenBudget: number;
  concurrency: number;
  delayMs: number;
  now: number; // epoch s, from the server (no hydration drift in the "< 7 ngày" count)
};

const WEEK_S = 7 * 86_400;
const COLUMNS = [
  { key: "path", header: "ĐƯỜNG DẪN", width: "minmax(0, 1fr)" },
  { key: "http", header: "HTTP", width: "160px" },
  { key: "auth", header: "ĐĂNG NHẬP", width: "150px" },
  { key: "captured", header: "ĐÃ CHỤP", width: "170px" },
];
const ESTIMATE_TITLE = "Ước tính thô: ~3.000 token/trang để đặt tên + ~60.000 token cho mỗi section cần sửa, chặn bởi ngân sách token.";
const shownPath = (path: string) => (path === "/" ? "/ (trang chủ)" : path);

function TriCheckbox({ state, label, disabled, onChange, visibleLabel }: { state: "all" | "some" | "none"; label: string; disabled: boolean; onChange(): void; visibleLabel?: ReactNode }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "some";
  }, [state]);
  const box = <input ref={ref} type="checkbox" checked={state === "all"} disabled={disabled} onChange={onChange} aria-label={visibleLabel ? undefined : label} />;
  return visibleLabel ? (
    <label className="check">
      {box}
      {visibleLabel}
    </label>
  ) : (
    box
  );
}

export function SitemapPicker({ projectId, pages, crawled, draft, rates, tokenBudget, concurrency, delayMs, now }: Props) {
  const router = useRouter();
  const [selected, setSelected] = useState(() => new Set(pages.map((p) => p.url)));
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [authMsg, setAuthMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [openBusy, setOpenBusy] = useState(false);
  const tree = useMemo(() => buildRouteTree(pages), [pages]);

  const recent = (p: SitemapPage) => p.capturedAt !== null && p.capturedAt >= now - WEEK_S;
  const inTab = (p: SitemapPage) => filter === "all" || (filter === "public" ? !p.needsAuth : filter === "auth" ? p.needsAuth : recent(p));
  const q = query.trim().toLowerCase();
  const shown = pages.filter((p) => inTab(p) && (!q || pathOf(p.url).toLowerCase().includes(q)));
  const shownUrls = new Set(shown.map((p) => p.url));
  const filtering = filter !== "all" || q !== "";
  // while filtering, every branch holding a match is open
  const rows = visibleRows(filtering ? filterTree(tree, (u) => shownUrls.has(u)) : tree, filtering ? new Set<string>() : closed);
  const counts = { all: pages.length, public: pages.filter((p) => !p.needsAuth).length, auth: pages.filter((p) => p.needsAuth).length, recent: pages.filter(recent).length };
  const authSelected = pages.filter((p) => p.needsAuth && selected.has(p.url)).length;
  const protectedBannerShown = draft && authSelected > 0;
  const est = estimateRun({ pages: selected.size, concurrency, delayMs, tokenBudget, ...rates });

  // The protected-pages banner (and its "Mở cửa sổ đăng nhập" / "Import cookie JSON" actions authMsg reports
  // on) is only reachable while shown; clear a stale message the moment it hides, so it never lingers after the
  // triggering page is deselected and never reappears stale if the banner comes back later (fix round 2 #12).
  useEffect(() => {
    if (!protectedBannerShown) setAuthMsg(null);
  }, [protectedBannerShown]);

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

  const setMany = (urls: string[], on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      for (const u of urls) {
        if (on) next.add(u);
        else next.delete(u);
      }
      return next;
    });

  const toggleOpen = (key: string) =>
    setClosed((c) => {
      const next = new Set(c);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const recrawl = () =>
    run(async () => {
      await api(`/api/projects/${projectId}/crawl`, { method: "POST" });
      router.refresh();
    });

  const start = () =>
    run(async () => {
      const urls = pages.filter((p) => selected.has(p.url)).map((p) => p.url).sort((a, b) => pathOf(a).localeCompare(pathOf(b)));
      await api(`/api/projects/${projectId}/start`, { body: { pages: urls } }); // closes an open login window first (D8)
      router.push(`/p/${projectId}`);
    });

  const openWindow = async () => {
    if (openBusy) return; // guard a double click: exactly one POST
    setOpenBusy(true);
    setAuthMsg(null);
    try {
      await api(`/api/projects/${projectId}/auth/open`, { method: "POST" });
      setAuthMsg({ ok: true, text: "Đã mở cửa sổ đăng nhập." });
    } catch (e) {
      setAuthMsg({ ok: false, text: errorText(e) });
    } finally {
      setOpenBusy(false);
    }
  };

  const importFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setAuthMsg(null);
    importSessionFile(projectId, file).then(
      (text) => setAuthMsg({ ok: true, text }),
      (err: unknown) => setAuthMsg({ ok: false, text: errorText(err) }),
    );
  };

  const cell = (r: RouteRow<SitemapPage>, key: string): ReactNode => {
    const p = r.page;
    if (key === "path") {
      const open = filtering || !closed.has(r.key);
      // Chevron/spacer first (a fixed alignment column across every depth), then the ├/└ connector sitting
      // right next to the checkbox — no reserved gap between them (P19 fix round 1 #6).
      return (
        <div className="tree-cell" style={{ paddingLeft: r.depth * 20 }}>
          {r.children.length > 0 ? (
            <IconButton icon="chevron_right" className={open ? "chev open" : "chev"} label={open ? `Thu gọn ${r.path}` : `Mở ${r.path}`} aria-expanded={open} onClick={() => toggleOpen(r.key)} />
          ) : (
            <span className="chev-space" />
          )}
          {r.depth > 0 && <span className={`tree-conn${r.isLast ? " last" : ""}`} aria-hidden="true" />}
          {r.kind === "folder" ? (
            <TriCheckbox state={selectionState(r.urls, selected)} label={`Chọn tất cả trong ${r.path}`} disabled={!draft} onChange={() => setMany(r.urls, selectionState(r.urls, selected) !== "all")} />
          ) : (
            <TriCheckbox state={selected.has(p!.url) ? "all" : "none"} label={shownPath(r.path)} disabled={!draft} onChange={() => setMany([p!.url], !selected.has(p!.url))} />
          )}
          <Icon name={r.kind === "folder" ? (open ? "folder_open" : "folder") : "description"} />
          {r.kind === "folder" ? (
            <span className="mono tree-label" title={r.path}>
              <span className="tree-label-main">{r.path}</span> <span className="tree-label-count">({r.urls.length} trang con)</span>
            </span>
          ) : (
            <span className="mono tree-label" title={r.path}>
              {shownPath(r.path)}
            </span>
          )}
        </div>
      );
    }
    if (!p) return null;
    if (key === "http") {
      const h = httpLabel(p);
      return h.text === "—" ? (
        <span className="text-3 captured-cell" data-ui="ui_sitemap_http_status">
          —
        </span>
      ) : (
        <Badge tone={h.tone} data-ui="ui_sitemap_http_status">
          {h.text}
        </Badge>
      );
    }
    if (key === "auth")
      return p.needsAuth ? (
        <Badge tone="warn" title="Trang này cần đăng nhập">
          <Icon name="lock" size={14} />
          Cần đăng nhập
        </Badge>
      ) : (
        <span className="text-3 captured-cell">—</span>
      );
    return p.capturedAt ? (
      <span className="captured-cell text-3">
        <RelTime at={p.capturedAt} prefix="đã chụp " data-ui="ui_sitemap_captured_at" />
      </span>
    ) : (
      <span className="text-3 captured-cell" data-ui="ui_sitemap_captured_at">
        Chưa chụp
      </span>
    );
  };

  const visibleState = selectionState(shown.map((p) => p.url), selected);

  return (
    <div className="stack sitemap-picker">
      {!draft && (
        <Banner data-ui="ui_sitemap_locked_note" tone="info" icon="lock">
          Đã bắt đầu clone — danh sách trang đã chốt. Dùng Clone lại để quét lại.
        </Banner>
      )}
      {msg && (
        <Banner tone="danger" icon="error">
          {msg}
        </Banner>
      )}
      {!crawled && (
        <Card data-ui="ui_sitemap_recrawl">
          <div className="row spread">
            <span className="text-2">Chưa có sitemap (lần quét trước chưa xong hoặc lỗi).</span>
            <Button icon="radar" disabled={busy || !draft} onClick={() => void recrawl()}>
              {busy ? "Đang quét…" : "Quét lại"}
            </Button>
          </div>
        </Card>
      )}
      {crawled && (
        <>
          <div className="sitemap-tools">
            <div className="row">
              <span className="sitemap-chip" data-ui="ui_sitemap_select_all">
                <TriCheckbox
                  state={visibleState}
                  label="Chọn tất cả"
                  disabled={!draft || shown.length === 0}
                  onChange={() => setMany(shown.map((p) => p.url), visibleState !== "all")}
                  visibleLabel={`Chọn tất cả (${shown.length})`}
                />
                <span className="text-3" aria-hidden="true">
                  •
                </span>
                <span className="t-label-sm sitemap-counter">
                  {selected.size} / {pages.length} đã chọn
                </span>
              </span>
              <span className="sitemap-chip t-label-sm text-3" data-ui="ui_sitemap_cost_estimate" title={ESTIMATE_TITLE}>
                {est.cappedByBudget ? `tối đa ${fmtTokens(tokenBudget)} token (ngân sách)` : `~${fmtTokens(est.tokens)} token (ước tính)`}
              </span>
            </div>
            <div className="row sitemap-search-row">
              <SearchInput data-ui="ui_sitemap_route_search" label="Lọc đường dẫn" placeholder="Lọc theo đường dẫn…" value={query} onChange={setQuery} />
              <span className="row sitemap-expand-group" data-ui="ui_sitemap_expand_collapse">
                <Button variant="ghost" icon="unfold_more" onClick={() => setClosed(new Set())}>
                  Mở hết
                </Button>
                <Button variant="ghost" icon="unfold_less" onClick={() => setClosed(new Set(parentKeys(tree)))}>
                  Thu gọn
                </Button>
              </span>
            </div>
          </div>
          <SegmentedControl<Filter>
            data-ui="ui_sitemap_filter_tabs"
            label="Bộ lọc trang"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: `Tất cả (${counts.all})` },
              { value: "public", label: `Công khai (${counts.public})` },
              { value: "auth", label: `Cần đăng nhập (${counts.auth})`, icon: "lock", tone: "warn" },
              { value: "recent", label: `Đã chụp < 7 ngày (${counts.recent})` },
            ]}
          />
          <GridTable
            data-ui="ui_sitemap_route_tree"
            label="Cây đường dẫn"
            columns={COLUMNS}
            rows={rows}
            rowKey={(r) => r.key}
            renderCell={cell}
            rowTone={(r) => (r.page?.needsAuth ? "warn" : undefined)}
            rowProps={(r) => ({
              className: r.page && !selected.has(r.page.url) ? "unselected" : undefined,
              "data-ui": r.page?.needsAuth ? "ui_sitemap_auth_gated_rows" : undefined,
            })}
            empty={<p className="table-empty">Không có trang nào khớp bộ lọc.</p>}
          />
          {protectedBannerShown && (
            <>
              <Banner
                data-ui="ui_sitemap_protected_banner"
                tone="warn"
                icon="lock"
                title={`Có ${authSelected} trang cần đăng nhập trong lựa chọn`}
                actions={
                  <>
                    <Button icon="open_in_new" disabled={openBusy} onClick={() => void openWindow()}>
                      Mở cửa sổ đăng nhập
                    </Button>
                    <label className="btn btn-secondary file-btn">
                      <Icon name="drive_folder_upload" />
                      Import cookie JSON
                      <input type="file" accept="application/json,.json" className="visually-hidden" onChange={importFile} />
                    </label>
                  </>
                }
              >
                Mở cửa sổ Chrome để đăng nhập (tự xử lý CAPTCHA nếu có), hoặc import cookie/storageState JSON. Phiên được lưu trong profile của dự án.
              </Banner>
              {authMsg && (
                <Banner
                  tone={authMsg.ok ? "info" : "danger"}
                  icon={authMsg.ok ? "check_circle" : "error"}
                  role={authMsg.ok ? "status" : "alert"}
                  actions={<IconButton icon="close" label="Đóng thông báo" onClick={() => setAuthMsg(null)} />}
                >
                  {authMsg.text}
                </Banner>
              )}
            </>
          )}
        </>
      )}
      <div className="action-bar" data-ui="ui_sitemap_action_bar">
        <span className="row action-bar-info">
          <span className="dot tone-primary" aria-hidden="true" />
          <span className="t-label-md">
            {selected.size} trang đã chọn
            {authSelected > 0 && <span className="text-warn"> ({authSelected} cần đăng nhập)</span>}
          </span>
          <span className="text-3" aria-hidden="true">
            •
          </span>
          <span className="t-label-md text-2" data-ui="ui_sitemap_runtime_estimate">
            Ước tính {fmtMinutes(est.seconds)}
          </span>
        </span>
        <span className="action-bar-end">
          <Button href="/" data-ui="ui_sitemap_cancel">
            Hủy
          </Button>
          <Button variant="primary" icon="play_arrow" data-ui="ui_sitemap_start_clone" disabled={busy || !draft || selected.size === 0} onClick={() => void start()}>
            Bắt đầu clone
          </Button>
        </span>
      </div>
    </div>
  );
}
