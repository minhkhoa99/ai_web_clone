"use client";
import { useEffect, useRef, useState } from "react";
import type { Bp, SectionScore } from "@/core/qa";
import { api, errorText } from "@/app/_ui/api";

type Data = {
  pages: { pageId: string; path: string; file?: string }[];
  sections: { id: string; pageId: string; name: string; rootId: string }[];
  scores: SectionScore[];
  interactions: { id: string; pageId: string; kind: string; trigger: string; status: string }[];
  coverage: { page: string; captured: number; failed: number; skipped: number }[];
};

const BPS: Bp[] = [375, 768, 1440];
const MAX_FRAME_H = 30_000; // a runaway (vh-driven) page can't grow the frame forever
const pct = (score: number) => `${(score * 100).toFixed(1)}%`;

export function PreviewView({ projectId, threshold }: { projectId: string; threshold: number }) {
  const [data, setData] = useState<Data | null>(null);
  const [msg, setMsg] = useState("");
  const [pageId, setPageId] = useState("");
  const [bp, setBp] = useState<Bp>(1440);
  const [overlay, setOverlay] = useState(false);
  const [slider, setSlider] = useState(50);
  const [heat, setHeat] = useState(false);
  const [tab, setTab] = useState<"sections" | "checklist">("sections");
  const [frameH, setFrameH] = useState(1000);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<Data>(`/api/projects/${projectId}/preview`).then(
      (d) => {
        setData(d);
        setPageId(d.pages[0]?.pageId ?? "");
      },
      (e: unknown) => setMsg(errorText(e)),
    );
  }, [projectId]);

  const fileUrl = (rel: string) => `/api/projects/${projectId}/files/${rel.split("/").map(encodeURIComponent).join("/")}`;
  const page = data?.pages.find((p) => p.pageId === pageId);
  const scale = Math.min(1, (overlay ? 1100 : 540) / bp);
  const names = new Map(data?.sections.map((s) => [s.id, s]));
  const scores = data?.scores.filter((s) => s.pageId === pageId && s.bp === bp) ?? [];
  const passing = scores.filter((s) => s.score >= threshold).length;

  const measure = () => {
    const doc = frameRef.current?.contentDocument;
    if (doc) setFrameH(Math.min(MAX_FRAME_H, Math.max(doc.documentElement.scrollHeight, 200)));
  };

  // The clone iframe is same-origin (files route), so its section roots ([data-ir-id]) can be located directly.
  const scrollToSection = (sectionId: string) => {
    const rootId = names.get(sectionId)?.rootId;
    const doc = frameRef.current?.contentDocument;
    const el = rootId && doc?.querySelector(`[data-ir-id="${CSS.escape(rootId)}"]`);
    if (!el || !doc?.defaultView) return;
    const top = el.getBoundingClientRect().top + doc.defaultView.scrollY;
    scrollRef.current?.scrollTo({ top: top * scale, behavior: "smooth" });
  };

  if (msg) return <p className="alert" role="alert">{msg}</p>;
  if (!data) return <p className="muted">Đang tải…</p>;
  if (!page) return <p className="muted">Chưa có output — chạy clone trước.</p>;

  const cloneFrame = (
    <div className="frame" style={{ width: bp * scale, height: frameH * scale }}>
      {page.file && (
        <iframe
          key={`${page.file}-${bp}`}
          ref={frameRef}
          title="Bản clone"
          src={fileUrl(`out/${page.file}`)}
          onLoad={measure}
          style={{ width: bp, height: frameH, transform: `scale(${scale})` }}
        />
      )}
    </div>
  );
  const original = <img alt="Bản gốc" src={fileUrl(`pages/${pageId}/shots/${bp}.png`)} style={{ width: bp * scale, display: "block" }} />;

  return (
    <div className="stack">
      <div className="row spread">
        <div className="row">
          <label className="field">
            Trang
            <select value={pageId} onChange={(e) => setPageId(e.target.value)}>
              {data.pages.map((p) => (
                <option key={p.pageId} value={p.pageId}>
                  {p.path}
                </option>
              ))}
            </select>
          </label>
          <div className="row" role="group" aria-label="Breakpoint">
            {BPS.map((b) => (
              <button key={b} className="btn mono" aria-pressed={bp === b} onClick={() => setBp(b)}>
                {b}px
              </button>
            ))}
          </div>
        </div>
        <div className="row">
          <button className="btn" aria-pressed={!overlay} onClick={() => setOverlay(false)}>
            Cạnh nhau
          </button>
          <button className="btn" aria-pressed={overlay} onClick={() => setOverlay(true)}>
            Chồng lớp
          </button>
          {overlay && (
            <label className="row">
              Overlay
              <input type="range" min={0} max={100} value={slider} onChange={(e) => setSlider(e.target.valueAsNumber)} />
            </label>
          )}
          <label className="row">
            <input type="checkbox" checked={heat} onChange={(e) => setHeat(e.target.checked)} />
            Heatmap
          </label>
        </div>
      </div>

      <div className="split" style={{ gridTemplateColumns: "minmax(0, 1fr) 380px" }}>
        <div className="compare" ref={scrollRef}>
          {overlay ? (
            <div className="compare-overlay" style={{ width: bp * scale }}>
              {original}
              <div className="clone" style={{ clipPath: `inset(0 ${100 - slider}% 0 0)` }}>
                {cloneFrame}
              </div>
            </div>
          ) : (
            <div className="compare-side">
              <div>
                <div className="pane-label">Gốc</div>
                {original}
              </div>
              <div>
                <div className="pane-label">Clone</div>
                {cloneFrame}
              </div>
            </div>
          )}
        </div>

        <aside className="stack">
          <div className="row" role="tablist">
            <button role="tab" className="btn" aria-selected={tab === "sections"} aria-pressed={tab === "sections"} onClick={() => setTab("sections")}>
              Section ({scores.length})
            </button>
            <button role="tab" className="btn" aria-selected={tab === "checklist"} aria-pressed={tab === "checklist"} onClick={() => setTab("checklist")}>
              Checklist độ phủ
            </button>
          </div>
          {tab === "sections" ? (
            <div className="card stack">
              <p className="muted">
                {passing}/{scores.length} section đạt ngưỡng {pct(threshold)}
              </p>
              {scores.length === 0 && <p className="muted">Chưa có điểm QA cho breakpoint này.</p>}
              <ul className="plain stack sections">
                {scores.map((s) => {
                  const ok = s.score >= threshold;
                  return (
                    <li key={s.sectionId}>
                      <button className="btn" onClick={() => scrollToSection(s.sectionId)}>
                        <span>{names.get(s.sectionId)?.name ?? s.sectionId}</span>
                        <span className={`score ${ok ? "pass" : "fail"}`}>
                          {pct(s.score)} {ok ? "đạt" : "chưa đạt"}
                        </span>
                      </button>
                      {heat && s.heatPath && <img className="heat" alt={`Heatmap ${s.sectionId}`} src={fileUrl(s.heatPath)} />}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : (
            <Checklist data={data} pageId={pageId} />
          )}
        </aside>
      </div>
    </div>
  );
}

function Checklist({ data, pageId }: { data: Data; pageId: string }) {
  const rows = data.interactions.filter((i) => i.pageId === pageId);
  return (
    <div className="card stack">
      <table>
        <thead>
          <tr>
            <th>Trang</th>
            <th>Đã chụp</th>
            <th>Lỗi</th>
            <th>Bỏ qua</th>
          </tr>
        </thead>
        <tbody>
          {data.coverage.map((c) => (
            <tr key={c.page}>
              <td className="mono">{c.page}</td>
              <td>{c.captured}</td>
              <td>{c.failed}</td>
              <td>{c.skipped}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Tương tác của trang</h3>
      {rows.length === 0 && <p className="muted">Không có tương tác nào.</p>}
      <ul className="plain">
        {rows.map((i) => (
          <li key={i.id} className="row spread">
            <span className="mono">
              {i.kind} · {i.trigger}
            </span>
            <span className={i.status === "captured" ? "score pass" : i.status === "failed" ? "score fail" : "score muted"}>{i.status}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
