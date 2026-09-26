"use client";
import { useEffect, useRef, useState, type FormEvent, type UIEvent } from "react";
import type { StampedEvent } from "@/core/jobs-base";
import { RESUMABLE_STATUSES } from "@/core/statuses";
import { api, errorText } from "@/app/_ui/api";
import { Banner } from "@/app/_ui/Banner";
import { Button } from "@/app/_ui/Button";
import { Card } from "@/app/_ui/Card";
import { Field } from "@/app/_ui/Field";
import { IconButton } from "@/app/_ui/IconButton";
import { LogView, type LogLine } from "@/app/_ui/LogView";
import { PasswordInput } from "@/app/_ui/PasswordInput";
import { SearchInput } from "@/app/_ui/SearchInput";
import { SegmentedControl } from "@/app/_ui/SegmentedControl";
import { StatTile } from "@/app/_ui/StatTile";
import { StatusPill } from "@/app/_ui/StatusPill";
import { UrlChip } from "@/app/_ui/UrlChip";
import { fmtDuration, fmtInt } from "@/app/_ui/format";
import { describe, pageStates, runSpan, spanAfter, stateLabel, type PageRef, type RunSpan, type TaskView } from "./page-states";
import { PhaseStepper, phaseStates } from "./phase-stepper";

export type { TaskView };
type Initial = { status: string; progress: number; tasks: TaskView[]; authUrl: string | null; needsCredentials: boolean; pages: PageRef[]; tokensUsed: number; tokenBudget: number };
type Level = "all" | LogLine["level"];
type Message = StampedEvent | { type: "history"; events: StampedEvent[] };

const MAX_LOG = 2_000; // lines kept on the client (the server replays at most 2000)
const MAX_RUNNING_SHOWN = 3;
const taskKey = (t: { phase: string; key: string }) => `${t.phase}:${t.key}`;

export function ProgressView({ projectId, url, initial }: { projectId: string; url: string; initial: Initial }) {
  const [status, setStatus] = useState(initial.status);
  const [progress, setProgress] = useState(initial.progress);
  const [tokensUsed, setTokensUsed] = useState(initial.tokensUsed);
  const [tasks, setTasks] = useState(() => new Map(initial.tasks.map((t) => [taskKey(t), t])));
  const [authUrl, setAuthUrl] = useState(initial.authUrl);
  const [log, setLog] = useState<LogLine[]>([]);
  const [span, setSpan] = useState<RunSpan>({ start: null, end: null });
  const [now, setNow] = useState(() => Date.now());
  const [level, setLevel] = useState<Level>("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const [wrap, setWrap] = useState(true);
  const [pageQuery, setPageQuery] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [needsCreds, setNeedsCreds] = useState(initial.needsCredentials);
  const [queued, setQueued] = useState(false); // set by the SSE's snapshot and by resume responses
  const [askFor, setAskFor] = useState<string | null>(null); // resume / auth/continue waiting for credentials
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let n = 0;
    const lineOf = (e: StampedEvent): LogLine[] => {
      const d = describe(e);
      return d ? [{ ...d, at: e.at, n: n++ }] : [];
    };
    const es = new EventSource(`/api/projects/${projectId}/events`);
    es.onmessage = (m: MessageEvent<string>) => {
      const ev = JSON.parse(m.data) as Message;
      if (ev.type === "history") {
        // the persisted tail REPLACES the log (a reconnect never duplicates lines); task/status state stays SSR + live
        setLog(ev.events.flatMap(lineOf).slice(-MAX_LOG));
        setSpan(runSpan(ev.events));
        return;
      }
      if (ev.type === "status") {
        setStatus(ev.status);
        setQueued(ev.queued ?? false); // any status the job itself emits means it left the queue
        if (ev.queued !== undefined) return; // the SSE's snapshot of the current status: not a transition, not a log line
        setSpan((s) => spanAfter(s, ev));
      }
      if (ev.type === "progress") {
        setProgress(ev.progress);
        setTokensUsed(ev.tokensUsed);
      }
      if (ev.type === "needs_auth") setAuthUrl(ev.url);
      if (ev.type === "task" && ev.phase === "login" && ev.errorCode === "LOGIN_FAILED") setNeedsCreds(true);
      if (ev.type === "task") setTasks((prev) => new Map(prev).set(taskKey(ev), { phase: ev.phase, key: ev.key, status: ev.status, errorCode: ev.errorCode ?? null }));
      const line = lineOf(ev);
      if (line.length) setLog((prev) => [...prev.slice(-(MAX_LOG - 1)), ...line]);
    };
    return () => es.close();
  }, [projectId]);

  useEffect(() => {
    if (status !== "running") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [status]);

  useEffect(() => {
    if (autoScroll) logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log, autoScroll, level, wrap]);

  // scrolling up turns auto-scroll off; the checkbox turns it back on
  const onLogScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (autoScroll && el.scrollHeight - el.scrollTop - el.clientHeight > 24) setAutoScroll(false);
  };

  const call = async (path: string, body?: unknown) => {
    setBusy(true);
    setMsg("");
    try {
      const r = await api<{ queued?: boolean }>(`/api/projects/${projectId}/${path}`, body === undefined ? { method: "POST" } : { body });
      if (r.queued) setQueued(true);
      return true;
    } catch (e) {
      setMsg(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  // Resume paths: auth mode auto without usable credentials asks for them first (spec §3).
  const resume = (path: string) => (needsCreds ? setAskFor(path) : void call(path));
  const submitCreds = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const credentials = { user: String(f.get("user")), pass: String(f.get("pass")), remember: f.get("remember") === "on" };
    if (askFor && (await call(askFor, { credentials }))) {
      setAskFor(null);
      setNeedsCreds(false);
    }
  };

  const all = [...tasks.values()];
  const running = all.filter((t) => t.status === "running");
  const states = pageStates(all, initial.pages);
  const pq = pageQuery.trim().toLowerCase();
  const shownPages = pq ? states.filter((p) => p.path.toLowerCase().includes(pq)) : states;
  const count = (...s: string[]) => states.filter((p) => s.includes(p.state)).length;
  const elapsedMs = span.start === null ? null : span.end !== null ? span.end - span.start : status === "running" ? now - span.start : null;
  const shownLines = level === "all" ? log : log.filter((l) => l.level === level);
  const warnN = log.filter((l) => l.level === "warn").length;
  const errorN = log.filter((l) => l.level === "error").length;

  return (
    <div className="stack progress-screen">
      <div className="context-bar" data-ui="ui_progress_context_bar">
        <span className="t-label-md text-3">Trang gốc:</span>
        <UrlChip url={url} openable />
        <StatusPill status={status} queued={queued} />
        <span className="t-label-md">{progress}%</span>
        <div className="context-stats" data-ui="ui_progress_stats_bar">
          <StatTile label="Thời gian chạy" value={elapsedMs === null ? "—" : fmtDuration(elapsedMs)} />
          <StatTile label="Token đã dùng" value={`${fmtInt(tokensUsed)} / ${fmtInt(initial.tokenBudget)}`} tone={tokensUsed >= 0.9 * initial.tokenBudget ? "warn" : undefined} />
        </div>
        <div className="context-controls" data-ui="ui_progress_controls">
          {status === "running" && (
            <Button icon="pause" disabled={busy} onClick={() => void call("pause")}>
              Tạm dừng
            </Button>
          )}
          {/* needs_auth resumes from its own banner (auth/continue) */}
          {RESUMABLE_STATUSES.includes(status) && status !== "needs_auth" && (
            <Button variant="primary" icon="play_arrow" disabled={busy} onClick={() => resume("resume")}>
              Tiếp tục
            </Button>
          )}
        </div>
      </div>

      <PhaseStepper states={phaseStates(all, status)} />

      {status === "needs_auth" && (
        <Banner
          data-ui="ui_progress_auth_banner"
          tone="warn"
          icon="warning"
          actions={
            <>
              <Button icon="open_in_new" disabled={busy} onClick={() => void call("auth/open")}>
                Mở cửa sổ
              </Button>
              <Button variant="warn" icon="play_arrow" disabled={busy} onClick={() => resume("auth/continue")}>
                Tiếp tục
              </Button>
            </>
          }
        >
          Trang <code className="inline-chip">{authUrl ?? url}</code> cần đăng nhập — Mở cửa sổ để đăng nhập, rồi bấm Tiếp tục
        </Banner>
      )}
      {askFor && (
        <Card data-ui="ui_progress_credentials_form" title="Đăng nhập lại">
          <form className="stack" aria-label="Đăng nhập lại" onSubmit={(e) => void submitCreds(e)}>
            <span className="text-2">Cần tài khoản để đăng nhập tự động (lần đăng nhập trước thất bại hoặc chưa có tài khoản).</span>
            <div className="creds-grid">
              <Field label="Tài khoản">
                <input name="user" required autoComplete="off" />
              </Field>
              <PasswordInput label="Mật khẩu" name="pass" required />
              <label className="check">
                <input name="remember" type="checkbox" />
                Ghi nhớ
              </label>
            </div>
            <div className="row">
              <Button type="submit" variant="primary" disabled={busy}>
                Tiếp tục với tài khoản này
              </Button>
              <Button onClick={() => setAskFor(null)}>Hủy</Button>
            </div>
          </form>
        </Card>
      )}
      {msg && (
        <Banner tone="danger" icon="error">
          {msg}
        </Banner>
      )}

      <div className="progress-grid">
        <section className="pane" aria-label="Trang" data-ui="ui_progress_page_list">
          <div className="pane-toolbar">
            <SearchInput label="Lọc trang" placeholder={`Lọc ${initial.pages.length} trang…`} value={pageQuery} onChange={setPageQuery} />
          </div>
          <ul className="page-states">
            {shownPages.map((p) => (
              <li key={p.pageId} className={`page-state state-${p.state}`}>
                <span className={`dot${p.state === "running" ? " ping" : ""}`} aria-hidden="true" />
                <span className="mono page-path" title={p.path}>
                  {p.path}
                </span>
                <span className="t-label-sm page-label">{stateLabel(p)}</span>
              </li>
            ))}
          </ul>
          <div className="pane-foot t-label-sm" data-ui="ui_progress_page_counts">
            <div className="counts-row">
              {/* the bullet lives inside the phrase that follows it, so a line can only break before "• phrase"
                  as one unit, never leaving a dangling "•" at the end of a line (fix round 2 #4) */}
              <span className="counts-list">
                <span className="nowrap">{count("done")} xong</span> <span className="nowrap">• {count("running")} đang chạy</span>{" "}
                <span className="nowrap">• {count("needs_auth")} cần đăng nhập</span> <span className="nowrap">• {count("failed", "skipped")} lỗi</span>{" "}
                <span className="nowrap">• {count("pending")} chờ</span>
              </span>
              <span className="counts-total nowrap">{states.length} trang</span>
            </div>
            {running.length > 0 && (
              <div className="text-2">
                Task đang chạy:{" "}
                {running
                  .slice(0, MAX_RUNNING_SHOWN)
                  .map((t) => `[${t.phase}] ${t.key}`)
                  .join(", ")}
                {running.length > MAX_RUNNING_SHOWN && ` +${running.length - MAX_RUNNING_SHOWN}`}
              </div>
            )}
          </div>
        </section>

        <section className="pane" aria-label="Log" data-ui="ui_progress_log_stream">
          <div className="pane-toolbar">
            <h2 className="t-label-md upper">Log</h2>
            <div className="log-toggles" data-ui="ui_progress_log_toggles">
              <label className="check">
                <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
                Tự cuộn
              </label>
              <label className="check">
                <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} />
                Xuống dòng
              </label>
            </div>
            <SegmentedControl<Level>
              data-ui="ui_progress_log_level_filter"
              label="Mức log"
              value={level}
              onChange={setLevel}
              options={[
                { value: "all", label: "Tất cả" },
                { value: "info", label: "Info" },
                {
                  value: "warn",
                  label: (
                    <>
                      Warn<span className="seg-count"> ({warnN})</span>
                    </>
                  ),
                },
                {
                  value: "error",
                  label: (
                    <>
                      Error<span className="seg-count"> ({errorN})</span>
                    </>
                  ),
                },
              ]}
            />
            <IconButton className="log-clear-btn" icon="block" label="Xóa log đang hiển thị (lịch sử vẫn giữ)" onClick={() => setLog([])} />
          </div>
          <LogView ref={logRef} lines={shownLines} wrap={wrap} empty="Đang chờ sự kiện…" onScroll={onLogScroll} lineUi="ui_progress_log_line" />
        </section>
      </div>
    </div>
  );
}
