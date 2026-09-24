"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { JobEvent } from "@/core/jobs-base";
import { api, errorText } from "@/app/_ui/api";
import { StatusPill } from "@/app/_ui/StatusPill";
import { PhaseStepper, phaseStates } from "./phase-stepper";

export type TaskView = { phase: string; key: string; status: string; errorCode: string | null };
type LogLine = { n: number; level: "info" | "warn" | "error"; text: string };
type Initial = { status: string; progress: number; tasks: TaskView[]; authUrl: string | null; needsCredentials: boolean };

const MAX_LOG = 500; // the log view keeps the newest lines only
const RESUMABLE = new Set(["paused", "interrupted", "failed"]);
const taskKey = (t: { phase: string; key: string }) => `${t.phase}:${t.key}`;

function describe(e: JobEvent): Omit<LogLine, "n"> | null {
  switch (e.type) {
    case "status":
      return { level: e.status === "failed" ? "error" : "info", text: `trạng thái → ${e.status}${e.reason ? ` (${e.reason})` : ""}` };
    case "phase":
      return { level: "info", text: `pha ${e.phase}` };
    case "task": {
      const level = e.status === "failed" ? "error" : e.status === "needs_auth" ? "warn" : "info";
      const detail = [e.errorCode, e.error].filter(Boolean).join(": ");
      return { level, text: `[${e.phase}] ${e.key} → ${e.status}${detail ? ` — ${detail}` : ""}` };
    }
    case "log":
      return { level: e.level, text: e.message };
    case "needs_auth":
      return { level: "warn", text: `cần đăng nhập: ${e.url} (${e.code})` };
    case "progress":
      return null;
  }
}

export function ProgressView({ projectId, url, initial }: { projectId: string; url: string; initial: Initial }) {
  const [status, setStatus] = useState(initial.status);
  const [progress, setProgress] = useState(initial.progress);
  const [tasks, setTasks] = useState(() => new Map(initial.tasks.map((t) => [taskKey(t), t])));
  const [authUrl, setAuthUrl] = useState(initial.authUrl);
  const [log, setLog] = useState<LogLine[]>([]);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [needsCreds, setNeedsCreds] = useState(initial.needsCredentials);
  const [askFor, setAskFor] = useState<string | null>(null); // resume / auth/continue waiting for credentials
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let n = 0;
    const es = new EventSource(`/api/projects/${projectId}/events`);
    es.onmessage = (m: MessageEvent<string>) => {
      const e = JSON.parse(m.data) as JobEvent;
      if (e.type === "status") setStatus(e.status);
      if (e.type === "progress") setProgress(e.progress);
      if (e.type === "needs_auth") setAuthUrl(e.url);
      if (e.type === "task" && e.phase === "login" && e.errorCode === "LOGIN_FAILED") setNeedsCreds(true);
      if (e.type === "task")
        setTasks((prev) => new Map(prev).set(taskKey(e), { phase: e.phase, key: e.key, status: e.status, errorCode: e.errorCode ?? null }));
      const line = describe(e);
      if (line) setLog((prev) => [...prev.slice(-(MAX_LOG - 1)), { ...line, n: n++ }]);
    };
    return () => es.close();
  }, [projectId]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  const call = async (path: string, body?: unknown) => {
    setBusy(true);
    setMsg("");
    try {
      await api(`/api/projects/${projectId}/${path}`, body === undefined ? { method: "POST" } : { body });
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

  return (
    <div className="stack">
      <div className="row spread card">
        <div className="row">
          <span className="mono">{url}</span>
          <StatusPill status={status} />
          <span className="mono">{progress}%</span>
        </div>
        <div className="row">
          {status === "running" && (
            <button className="btn" disabled={busy} onClick={() => void call("pause")}>
              Tạm dừng
            </button>
          )}
          {RESUMABLE.has(status) && (
            <button className="btn primary" disabled={busy} onClick={() => resume("resume")}>
              Tiếp tục
            </button>
          )}
        </div>
      </div>

      <PhaseStepper states={phaseStates(all, status)} />

      {status === "needs_auth" && (
        <div className="auth-banner" role="alert">
          <span>Trang {authUrl ?? url} cần đăng nhập — Mở cửa sổ để đăng nhập, rồi bấm Tiếp tục</span>
          <div className="row">
            <button className="btn" disabled={busy} onClick={() => void call("auth/open")}>
              Mở cửa sổ
            </button>
            <button className="btn warn" disabled={busy} onClick={() => resume("auth/continue")}>
              Tiếp tục
            </button>
          </div>
        </div>
      )}
      {askFor && (
        <form className="card stack" aria-label="Đăng nhập lại" onSubmit={(e) => void submitCreds(e)}>
          <span>Cần tài khoản để đăng nhập tự động (lần đăng nhập trước thất bại hoặc chưa có tài khoản).</span>
          <div className="grid-3">
            <label className="field">
              Tài khoản
              <input name="user" required autoComplete="off" />
            </label>
            <label className="field">
              Mật khẩu
              <input name="pass" required type="password" autoComplete="off" />
            </label>
            <label className="row">
              <input name="remember" type="checkbox" />
              Ghi nhớ
            </label>
          </div>
          <div className="row">
            <button className="btn primary" disabled={busy}>
              Tiếp tục với tài khoản này
            </button>
            <button type="button" className="btn" onClick={() => setAskFor(null)}>
              Hủy
            </button>
          </div>
        </form>
      )}
      {msg && <p className="alert" role="alert">{msg}</p>}

      <div className="split">
        <section className="card">
          <h2>Task đang chạy</h2>
          {running.length === 0 && <p className="muted">Không có task nào đang chạy.</p>}
          <ul className="plain">
            {running.map((t) => (
              <li key={taskKey(t)} className="mono">
                [{t.phase}] {t.key}
              </li>
            ))}
          </ul>
          <p className="muted">
            {all.filter((t) => t.status === "done").length}/{all.length} task xong
            {all.some((t) => t.status === "failed") && ` · ${all.filter((t) => t.status === "failed").length} lỗi`}
          </p>
        </section>
        <section>
          <h2>Log</h2>
          <pre className="log" ref={logRef} role="log" aria-live="polite">
            {log.length === 0 && <span className="muted">Đang chờ sự kiện…</span>}
            {log.map((l) => (
              <div key={l.n} className={l.level}>
                {l.text}
              </div>
            ))}
          </pre>
        </section>
      </div>
    </div>
  );
}
