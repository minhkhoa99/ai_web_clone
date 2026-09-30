"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FidelityItem } from "@/core/ir-v2";
import type { Bp, SectionScore } from "@/core/qa";
import { api, errorText } from "@/app/_ui/api";
import { Badge } from "@/app/_ui/Badge";
import { Banner } from "@/app/_ui/Banner";
import { Button } from "@/app/_ui/Button";
import { GridTable } from "@/app/_ui/GridTable";
import { Icon } from "@/app/_ui/Icon";
import { SegmentedControl } from "@/app/_ui/SegmentedControl";
import { fmtPct } from "@/app/_ui/format";
import {
  checklistLabel,
  FIDELITY_LABEL,
  FIDELITY_STATUSES,
  fidelityCounts,
  fidelityRows,
  filterFidelity,
  fixText,
  meanScore,
  nodeTarget,
  type FidelityStatus,
  type Fix,
} from "./preview-model";

type Data = {
  pages: { pageId: string; path: string; file?: string }[];
  sections: { id: string; pageId: string; name: string; rootId: string }[];
  scores: SectionScore[];
  stale: boolean; // edited in the editor after scoring
  rescoreAvailable: boolean; // server-computed: same rule as the rescore API (emit done, no earlier phase left, not running/queued)
  interactions: { id: string; pageId: string; kind: string; trigger: string; status: string }[];
  coverage: { page: string; captured: number; failed: number; skipped: number }[];
  fixes: Fix[];
  fidelity: FidelityItem[]; // E1 §5, <= 2000 items: its own report, never part of the pixel score
};
type Mode = "side" | "onion" | "swipe";
type Box = { x: number; y: number; w: number; h: number };
type Rescore = "idle" | "running" | { failed: string };

const BPS: Bp[] = [375, 768, 1440];
const MAX_FRAME_H = 30_000; // a runaway (vh-driven) page can't grow the frame forever
const PANE_GAP = 12;
const AREA_PAD = 24; // compare area padding (12px each side)

export function PreviewView({ projectId, threshold, status }: { projectId: string; threshold: number; status: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [msg, setMsg] = useState("");
  const [pageId, setPageId] = useState("");
  const [bp, setBp] = useState<Bp>(1440);
  const [mode, setMode] = useState<Mode>("side");
  const [slider, setSlider] = useState(50);
  const [heat, setHeat] = useState(false);
  const [tab, setTab] = useState<"sections" | "checklist" | "fidelity">("sections");
  const [frameH, setFrameH] = useState(1000);
  const [origH, setOrigH] = useState(0); // the original shot's natural height (it is bp px wide)
  const [areaW, setAreaW] = useState(0);
  const [boxes, setBoxes] = useState<Record<string, Box>>({});
  const [present, setPresent] = useState<ReadonlySet<string>>(new Set()); // Fidelity node ids the loaded clone page has
  const [marked, setMarked] = useState<string | null>(null);
  const [rescore, setRescore] = useState<Rescore>("idle");
  const frameRef = useRef<HTMLIFrameElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);
  const posting = useRef(false); // one POST per run even if a second click lands before the disabled re-render

  // rejects on an API error: the first load shows it in place of the screen, a re-score follow reports it in the banner
  const load = useCallback(
    () =>
      api<Data>(`/api/projects/${projectId}/preview`).then((d) => {
        setData(d);
        setPageId((cur) => (d.pages.some((p) => p.pageId === cur) ? cur : (d.pages[0]?.pageId ?? "")));
        return d;
      }),
    [projectId],
  );
  useEffect(() => {
    load().catch((e: unknown) => setMsg(errorText(e)));
  }, [load]);
  useEffect(() => () => esRef.current?.close(), []);

  const hasPage = !!data?.pages.some((p) => p.pageId === pageId);
  // the compare area's width drives the scale (no fixed pane width)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAreaW(el.clientWidth));
    ro.observe(el);
    setAreaW(el.clientWidth);
    return () => ro.disconnect();
  }, [hasPage]);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 }); // scrollTo returns a Promise in current Chrome: never the effect cleanup
  }, [pageId]);

  const fileUrl = (rel: string) => `/api/projects/${projectId}/files/${rel.split("/").map(encodeURIComponent).join("/")}`;
  const page = data?.pages.find((p) => p.pageId === pageId);
  const inner = Math.max(0, areaW - AREA_PAD);
  const scale = areaW === 0 ? Math.min(1, 440 / bp) : Math.min(1, mode === "side" ? (inner - PANE_GAP) / 2 / bp : inner / bp);
  const names = new Map(data?.sections.map((s) => [s.id, s]));
  const pageSections = data?.sections.filter((s) => s.pageId === pageId) ?? [];
  const scores = data?.scores.filter((s) => s.pageId === pageId && s.bp === bp) ?? [];
  const failing = scores.filter((s) => s.score < threshold);
  const mean = meanScore(scores);
  const fixes = new Map(data?.fixes.map((f) => [`${f.pageId}:${f.sectionId}`, f]));
  const pageInteractions = data?.interactions.filter((i) => i.pageId === pageId) ?? [];

  // The clone iframe is same-origin (files route): measure its height and each section root's box ([data-ir-id]).
  const measure = () => {
    const frame = frameRef.current;
    const doc = frame?.contentDocument;
    const win = doc?.defaultView;
    if (!frame || !doc || !win) return;
    frame.style.height = "0px"; // measure the content, not the previous frame height
    const h = Math.min(MAX_FRAME_H, Math.max(doc.documentElement.scrollHeight, 200));
    frame.style.height = `${Math.max(h, origH)}px`; // React skips the style write when the height is unchanged
    setFrameH(h);
    const next: Record<string, Box> = {};
    for (const s of pageSections) {
      const el = doc.querySelector(`[data-ir-id="${CSS.escape(s.rootId)}"]`);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      next[s.id] = { x: r.left + win.scrollX, y: r.top + win.scrollY, w: r.width, h: r.height };
    }
    setBoxes(next);
    const ids = (data?.fidelity ?? []).flatMap((x) => (x.pageId === pageId && x.nodeId ? [x.nodeId] : []));
    setPresent(new Set(ids.filter((id) => doc.querySelector(`[data-ir-id="${CSS.escape(id)}"]`))));
  };

  const scrollToNode = (irId: string | undefined) => {
    const doc = frameRef.current?.contentDocument;
    const el = irId && doc?.querySelector(`[data-ir-id="${CSS.escape(irId)}"]`);
    if (!el || !doc?.defaultView) return;
    const top = el.getBoundingClientRect().top + doc.defaultView.scrollY;
    scrollRef.current?.scrollTo({ top: top * scale, behavior: "smooth" });
  };
  const scrollToSection = (sectionId: string) => scrollToNode(names.get(sectionId)?.rootId);

  const pick = (sectionId: string) => {
    setMarked(sectionId);
    scrollToSection(sectionId);
  };

  // next section below the gate, wrapping around
  const nextDiff = () => {
    if (failing.length === 0) return;
    const i = failing.findIndex((s) => s.sectionId === marked);
    pick(failing[(i + 1) % failing.length]!.sectionId);
  };

  // D3: POST -> the job queue; follow the SSE until the run leaves `running`, then reload the scores.
  const rerun = async () => {
    if (posting.current) return;
    posting.current = true;
    setRescore("running");
    try {
      await api(`/api/projects/${projectId}/qa/rescore`, { method: "POST" });
    } catch (e) {
      posting.current = false;
      setRescore({ failed: errorText(e) });
      return;
    }
    esRef.current?.close();
    const es = new EventSource(`/api/projects/${projectId}/events`);
    esRef.current = es;
    const finish = (r: Rescore) => {
      es.close();
      posting.current = false;
      setRescore(r);
    };
    let completions = 0;
    es.onmessage = (m: MessageEvent<string>) => {
      const e = JSON.parse(m.data) as { type: string; status?: string; reason?: string; queued?: boolean };
      if (e.type !== "status") return;
      if (e.status === "completed" && !e.queued) {
        // the connect snapshot can still say `completed` before the queued job flips to running: a fresh
        // (non-stale) qa.json means the re-score is done; a second `completed` ends the follow either way
        const last = ++completions >= 2;
        load().then(
          (d) => {
            if (!d.stale || last) finish("idle");
          },
          (err: unknown) => finish({ failed: errorText(err) }),
        );
      } else if (e.status === "failed" || e.status === "paused" || e.status === "interrupted") {
        finish({ failed: e.reason ?? e.status });
      }
    };
  };

  if (msg)
    return (
      <Banner tone="danger" icon="error">
        {msg}
      </Banner>
    );
  if (!data) return <p className="text-3">Đang tải…</p>;
  if (!page) return <p className="text-3">Chưa có output — chạy clone trước.</p>;

  const paneH = Math.max(frameH, origH); // the clone is at least as tall as the original shot (its viewport)
  const heatImgs = heat
    ? scores.flatMap((s) => {
        const b = boxes[s.sectionId];
        return s.heatPath && b ? [<img key={s.sectionId} className="heat-overlay" alt="" src={fileUrl(s.heatPath)} style={{ left: b.x * scale, top: b.y * scale, width: b.w * scale, height: b.h * scale }} />] : [];
      })
    : null;
  const cloneFrame = (
    <div className="frame clone-frame" style={{ width: bp * scale, height: paneH * scale, ...(mode === "onion" ? { opacity: slider / 100 } : {}) }}>
      {page.file && (
        <iframe
          key={`${page.file}-${bp}`}
          ref={frameRef}
          title="Bản clone"
          src={fileUrl(`out/${page.file}`)}
          onLoad={measure}
          style={{ width: bp, height: paneH, transform: `scale(${scale})` }}
        />
      )}
      {heatImgs}
    </div>
  );
  const original = (
    <img className="orig-shot" alt="Bản gốc" src={fileUrl(`pages/${pageId}/shots/${bp}.png`)} onLoad={(e) => setOrigH(e.currentTarget.naturalHeight)} style={{ width: bp * scale }} />
  );
  // pane chrome: 3 window dots + "<label> · <bp> × <height>px", sticky at the top of the shared scroll area
  const head = (label: string, h: number) => (
    <div className="pane-sticky">
      <div className="pane-head mono">
        <span className="pane-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        {/* a narrow pane truncates the label, never the size */}
        <span className="pane-name">{label}</span>
        <span className="pane-size">{` · ${bp} × ${Math.round(h)}px`}</span>
      </div>
    </div>
  );

  return (
    <div className="stack qa-screen">
      <div className="qa-toolbar">
        <div className="qa-tools">
          <label className="inline-field" data-ui="ui_qa_preview_page_select">
            <span className="field-label">Trang</span>
            <select value={pageId} onChange={(e) => setPageId(e.target.value)}>
              {data.pages.map((p) => (
                <option key={p.pageId} value={p.pageId}>
                  {p.path}
                </option>
              ))}
            </select>
          </label>
          <SegmentedControl
            data-ui="ui_qa_preview_breakpoint_switch"
            label="Breakpoint"
            value={String(bp)}
            onChange={(v) => setBp(Number(v) as Bp)}
            options={BPS.map((b) => ({ value: String(b), label: `${b}px`, icon: b === 375 ? "phone_iphone" : b === 768 ? "tablet_mac" : "desktop_windows" }))}
          />
          <SegmentedControl<Mode>
            data-ui="ui_qa_preview_compare_modes"
            label="Chế độ so sánh"
            value={mode}
            onChange={setMode}
            // the slider needs the room at 1440: its modes drop their icons (the labels stay)
            options={[
              { value: "side", label: "Cạnh nhau", icon: mode === "side" ? "view_column_2" : undefined },
              { value: "onion", label: "Chồng mờ", icon: mode === "side" ? "opacity" : undefined },
              {
                value: "swipe",
                label: (
                  <>
                    Trượt<span className="mode-long"> so sánh</span>
                  </>
                ),
                icon: mode === "side" ? "compare" : undefined,
              },
            ]}
          />
          {mode !== "side" && (
            <label className="inline-field overlay-slider" data-ui="ui_qa_preview_overlay_slider">
              {/* compact for the one-row toolbar: the value shows, the name ("Độ trong" / "Vị trí") is the slider's aria-label */}
              <span className="t-label-md text-2 slider-value">{slider}%</span>
              <input
                type="range"
                className="qa-slider"
                min={0}
                max={100}
                value={slider}
                aria-label={mode === "onion" ? "Độ trong" : "Vị trí"}
                aria-valuetext={`${slider}%`}
                onChange={(e) => setSlider(e.target.valueAsNumber)}
              />
            </label>
          )}
        </div>
        <div className="qa-tools">
          <Button data-ui="ui_qa_preview_heatmap_toggle" icon="layers" aria-pressed={heat} onClick={() => setHeat((h) => !h)}>
            Heatmap
          </Button>
          {mean !== null && (
            <span
              data-ui="ui_qa_preview_match_score"
              className={`match-chip tint tone-${failing.length === 0 ? "success" : "danger"}`}
              title={`Trung bình ${scores.length} section; cổng đạt tính theo từng section`}
            >
              {fmtPct(mean)} khớp
            </span>
          )}
          <Button data-ui="ui_qa_preview_export_button" icon="download" href={`/p/${projectId}/code`}>
            Xuất mã
          </Button>
        </div>
      </div>

      <div className="qa-body">
        {/* one scroll container for both panes: scrolling always stays in sync (no toggle) */}
        <div className="compare-area" ref={scrollRef} data-ui="ui_qa_preview_sync_scroll">
          {mode === "side" ? (
            <div className="compare-side" style={{ gap: PANE_GAP }} data-ui="ui_qa_preview_side_by_side_panes">
              <div className="pane-col" style={{ width: bp * scale }}>
                {head("Gốc", origH)}
                {original}
              </div>
              <div className="pane-col" style={{ width: bp * scale }}>
                {head("Clone", frameH)}
                {cloneFrame}
              </div>
            </div>
          ) : (
            <div className="pane-col" style={{ width: bp * scale }} data-ui="ui_qa_preview_side_by_side_panes">
              {head(mode === "onion" ? "Gốc + Clone" : "Gốc | Clone", paneH)}
              <div className="compare-overlay">
                {original}
                <div className="overlay-clone" style={mode === "swipe" ? { clipPath: `inset(0 ${100 - slider}% 0 0)` } : undefined}>
                  {cloneFrame}
                </div>
              </div>
            </div>
          )}
        </div>

        <aside className="qa-rail">
          {(data.stale || status !== "completed") && data.rescoreAvailable && (
            <Banner
              data-ui="ui_qa_preview_rerun_qa"
              tone="info"
              icon="replay"
              actions={
                <Button variant="primary" icon="replay" disabled={rescore === "running"} onClick={() => void rerun()}>
                  {rescore === "running" ? "Đang chấm lại…" : "Chạy lại QA"}
                </Button>
              }
            >
              Điểm QA chưa cập nhật sau chỉnh sửa.
              {typeof rescore === "object" && (
                <span className="text-danger">
                  {" "}
                  {rescore.failed} — <Link href={`/p/${projectId}`}>Xem tiến độ</Link>
                </span>
              )}
            </Banner>
          )}
          <div className="panel rail-box">
            <SegmentedControl<"sections" | "checklist" | "fidelity">
              data-ui="ui_qa_preview_rail_tabs"
              semantics="tabs"
              full
              label="Bảng bên"
              value={tab}
              onChange={setTab}
              options={[
                { value: "sections", label: `Section (${scores.length})` },
                { value: "checklist", label: `Checklist độ phủ (${pageInteractions.length})` },
                { value: "fidelity", label: `Fidelity (${data.fidelity.length})` },
              ]}
            />
            {tab === "sections" ? (
              <div className="rail-panel" role="tabpanel">
                <div className="rail-summary t-label-sm" data-ui="ui_qa_preview_summary">
                  <span className="dot tone-success" aria-hidden="true" />
                  <span>
                    {scores.length - failing.length} đạt • <span className={failing.length ? "text-danger" : undefined}>{failing.length} cần sửa</span> · ngưỡng {fmtPct(threshold)}
                  </span>
                </div>
                <div className="rail-scroll">
                  {scores.length === 0 && <p className="text-3">Chưa có điểm QA cho breakpoint này.</p>}
                  <ul className="section-list" data-ui="ui_qa_preview_section_scores">
                    {scores.map((s) => {
                      const ok = s.score >= threshold;
                      const name = names.get(s.sectionId)?.name ?? s.sectionId;
                      const fix = fixes.get(`${s.pageId}:${s.sectionId}`);
                      return (
                        <li key={s.sectionId} className={ok ? undefined : "section-fail"} data-marked={marked === s.sectionId ? "true" : undefined}>
                          <button type="button" className="section-row" onClick={() => pick(s.sectionId)}>
                            <span className={`dot tone-${ok ? "success" : "danger"}`} aria-hidden="true" />
                            <span className="mono section-name">{name}</span>
                            <Badge tone={ok ? "success" : "danger"}>{fmtPct(s.score)}</Badge>
                            <Icon name="chevron_right" />
                          </button>
                          {!ok && (
                            <div className="fix-card" data-ui="ui_qa_preview_fix_request">
                              <div className="fix-status">
                                <Badge tone="danger">cần sửa</Badge>
                                <span className="t-body-sm fix-text">
                                  {fixText(fix, status)}
                                  {fix?.errorMsg && <span className="fix-msg">{fix.errorMsg}</span>}
                                </span>
                              </div>
                              {s.heatPath && (
                                <figure className="fix-heat">
                                  <img alt={`Heatmap ${name}`} src={fileUrl(s.heatPath)} />
                                  <figcaption className="t-label-sm text-3">Heatmap · {s.bp}px</figcaption>
                                </figure>
                              )}
                              <Button variant="primary" icon="edit" href={`/p/${projectId}/editor?page=${encodeURIComponent(s.pageId)}`}>
                                Sửa trong editor
                              </Button>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
                <div className="rail-foot">
                  <Button data-ui="ui_qa_preview_next_diff" icon="arrow_forward" disabled={failing.length === 0} onClick={nextDiff}>
                    Section chưa đạt tiếp theo
                  </Button>
                </div>
              </div>
            ) : tab === "checklist" ? (
              <Checklist data={data} rows={pageInteractions} />
            ) : (
              <Fidelity projectId={projectId} data={data} loadedPage={pageId} present={present} onGo={scrollToNode} />
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function Checklist({ data, rows }: { data: Data; rows: Data["interactions"] }) {
  const captured = rows.filter((i) => i.status === "captured").length;
  return (
    <div className="rail-panel" role="tabpanel" data-ui="ui_qa_preview_coverage_checklist">
      <div className="rail-summary">
        <span className="t-label-sm upper">CHECKLIST ĐỘ PHỦ</span>
        <span className="t-label-sm text-2 rail-summary-end">
          {captured}/{rows.length} đã chụp
        </span>
      </div>
      <div className="rail-scroll">
        <GridTable
          label="Độ phủ theo trang"
          columns={[
            { key: "page", header: "Trang", width: "minmax(0, 1fr)" },
            { key: "captured", header: "Đã chụp", width: "64px" },
            { key: "failed", header: "Lỗi", width: "36px" },
            { key: "skipped", header: "Bỏ qua", width: "56px" },
          ]}
          rows={data.coverage}
          rowKey={(c) => c.page}
          renderCell={(c, k) => (k === "page" ? <span className="mono ellipsis cov-page" title={c.page}>{c.page}</span> : k === "captured" ? c.captured : k === "failed" ? c.failed : c.skipped)}
        />
        {rows.length === 0 && <p className="text-3">Không có tương tác nào.</p>}
        <ul className="checklist">
          {rows.map((i) => (
            <li key={i.id} className={`check-row check-${i.status}`} data-ui={i.status === "skipped" ? "ui_qa_preview_skipped_item" : undefined}>
              <Icon name={i.status === "captured" ? "check" : i.status === "failed" ? "close" : "remove"} />
              <span className="check-label">{checklistLabel(i.kind, i.trigger)}</span>
              <span className="t-label-sm check-status">{i.status === "captured" ? "đã chụp" : i.status === "failed" ? "lỗi" : "bỏ qua"}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const FIDELITY_TONE: Record<FidelityStatus, "success" | "warn" | "danger"> = { supported: "success", partial: "warn", unsupported: "danger" };

// E1 §5: counts per status, filter by page + status, one row per item (the pages' script items as one row), a node
// link only when the loaded clone page has that node, else its capture anchor. Export = the filtered items as JSON.
function Fidelity({ projectId, data, loadedPage, present, onGo }: { projectId: string; data: Data; loadedPage: string; present: ReadonlySet<string>; onGo(irId: string): void }) {
  const [page, setPage] = useState("all");
  const [status, setStatus] = useState<FidelityStatus | "all">("all");
  const byPage = filterFidelity(data.fidelity, page, "all");
  const counts = fidelityCounts(byPage);
  const shown = filterFidelity(byPage, "all", status);
  const paths = new Map(data.pages.map((p) => [p.pageId, p.path]));
  const exportJson = () => {
    const body = JSON.stringify({ projectId, page, status, counts: fidelityCounts(shown), items: shown }, null, 2);
    const href = URL.createObjectURL(new Blob([body], { type: "application/json" }));
    Object.assign(document.createElement("a"), { href, download: `fidelity-${projectId}.json` }).click();
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
  };
  return (
    <div className="rail-panel" role="tabpanel" data-ui="ui_qa_preview_fidelity_panel">
      <div className="rail-summary fid-counts" data-ui="ui_qa_preview_fidelity_summary">
        {FIDELITY_STATUSES.map((s) => (
          <Badge key={s} tone={FIDELITY_TONE[s]}>
            {counts[s]} {FIDELITY_LABEL[s].toLowerCase()}
          </Badge>
        ))}
      </div>
      <div className="fid-filters" data-ui="ui_qa_preview_fidelity_filters">
        <label className="inline-field">
          <span className="field-label">Trang</span>
          <select value={page} onChange={(e) => setPage(e.target.value)}>
            <option value="all">Tất cả trang</option>
            {data.pages.map((p) => (
              <option key={p.pageId} value={p.pageId}>
                {p.path}
              </option>
            ))}
          </select>
        </label>
        <label className="inline-field">
          <span className="field-label">Trạng thái</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as FidelityStatus | "all")}>
            <option value="all">Tất cả</option>
            {FIDELITY_STATUSES.map((s) => (
              <option key={s} value={s}>
                {FIDELITY_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="rail-scroll">
        {shown.length === 0 && <p className="text-3">Không có mục Fidelity nào.</p>}
        <ul className="checklist" data-ui="ui_qa_preview_fidelity_list">
          {fidelityRows(shown).map(({ item, pages }, i) => {
            const target = nodeTarget(item, loadedPage, present);
            const ref = item.sourceRef ?? item.nodeId;
            return (
              <li key={i} className="fid-row" data-status={item.status}>
                <div className="fid-head">
                  <Badge tone={FIDELITY_TONE[item.status]}>{FIDELITY_LABEL[item.status]}</Badge>
                  <span className="mono fid-feature">{item.feature}</span>
                  <span className="t-label-sm text-3 fid-where">
                    {pages > 1 ? `${pages} trang` : (paths.get(item.pageId) ?? item.pageId)}
                    {item.breakpoint ? ` · ${item.breakpoint}px` : ""}
                  </span>
                </div>
                <p className="t-body-sm fid-note">{item.note}</p>
                {target ? (
                  <Button variant="ghost" icon="arrow_forward" aria-label={`Tới node ${item.feature}`} onClick={() => onGo(target)}>
                    Tới node
                  </Button>
                ) : (
                  ref && <span className="mono t-label-sm text-3 fid-ref">nguồn: {ref}</span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      <div className="rail-foot">
        <Button data-ui="ui_qa_preview_fidelity_export" icon="download" disabled={shown.length === 0} onClick={exportJson}>
          Xuất JSON
        </Button>
      </div>
    </div>
  );
}
