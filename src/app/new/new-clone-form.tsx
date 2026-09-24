"use client";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import type { ProjectConfig } from "@/core/jobs-base";
import { api, errorText } from "@/app/_ui/api";

type Mode = "single" | "crawl";
type AuthMode = ProjectConfig["auth"]["mode"];
type Initial = { url: string; mode: Mode; config: ProjectConfig };

const AUTH_MODES: [AuthMode, string][] = [
  ["none", "Không"],
  ["manual", "Thủ công (tự đăng nhập trong cửa sổ Chrome)"],
  ["auto", "Tự động (tài khoản)"],
];
const SP2_OUTPUTS = ["React", "Next.js", "Vue", "WordPress"];

export function NewCloneForm({ initial }: { initial?: Initial }) {
  const router = useRouter();
  const cfg = initial?.config;
  const [url, setUrl] = useState(initial?.url ?? "");
  const [mode, setMode] = useState<Mode>(initial?.mode ?? "single");
  const [maxPages, setMaxPages] = useState(cfg?.maxPages ?? 20);
  const [depth, setDepth] = useState(cfg?.depth ?? 2);
  const [concurrency, setConcurrency] = useState(cfg?.concurrency ?? 3);
  const [delayMs, setDelayMs] = useState(cfg?.delayMs ?? 500);
  const [selectors, setSelectors] = useState({ user: cfg?.auth.selectors?.user ?? "", pass: cfg?.auth.selectors?.pass ?? "", submit: cfg?.auth.selectors?.submit ?? "" });
  const [authMode, setAuthMode] = useState<AuthMode>(cfg?.auth.mode ?? "none");
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [remember, setRemember] = useState(false);
  const [threshold, setThreshold] = useState(Math.round((cfg?.threshold ?? 0.95) * 100));
  const [tokenBudget, setTokenBudget] = useState(cfg ? String(cfg.tokenBudget) : "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [loginFirst, setLoginFirst] = useState(false); // manual auth: log in in the window, then crawl

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg("");
    try {
      await fn();
    } catch (err) {
      setMsg(errorText(err));
      setBusy(false);
    }
  };

  const crawl = async (id: string) => {
    await api(`/api/projects/${id}/crawl`, { method: "POST" });
    router.push(`/p/${id}/sitemap`);
  };

  // Create, then crawl the sitemap for the page picker (manual auth: after the user logged in in the window).
  // A failed crawl leaves the draft project, linked below.
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg("");
    try {
      // only the selectors the user filled in; none -> the login form is found heuristically
      const filled = Object.fromEntries(Object.entries(selectors).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()]));
      const config = {
        maxPages,
        depth,
        concurrency,
        delayMs,
        threshold: threshold / 100,
        ...(tokenBudget ? { tokenBudget: Number(tokenBudget) } : {}),
        auth: { mode: authMode, ...(authMode === "auto" && Object.keys(filled).length > 0 ? { selectors: filled } : {}) },
      };
      const credentials = authMode === "auto" ? { credentials: { user, pass, remember } } : {};
      const { id } = await api<{ id: string }>("/api/projects", { body: { url, mode, config, ...credentials } });
      setCreated(id);
      if (authMode === "manual") {
        setLoginFirst(true);
        setBusy(false);
        return;
      }
      await crawl(id);
    } catch (err) {
      setMsg(errorText(err));
      setBusy(false);
    }
  };

  return (
    <form className="stack" style={{ maxWidth: 820 }} onSubmit={(e) => void submit(e)}>
      <label className="field">
        URL
        <input required type="url" className="mono" placeholder="https://example.com" value={url} onChange={(e) => setUrl(e.target.value)} />
      </label>

      <fieldset>
        <legend>Chế độ</legend>
        <label className="row">
          <input type="radio" name="mode" checked={mode === "single"} onChange={() => setMode("single")} />1 trang đầy đủ
        </label>
        <label className="row">
          <input type="radio" name="mode" checked={mode === "crawl"} onChange={() => setMode("crawl")} />
          Crawl nhiều trang
        </label>
        {mode === "crawl" && (
          <div className="grid-3">
            <label className="field">
              Số trang tối đa
              <input type="number" min={1} max={100} required value={maxPages} onChange={(e) => setMaxPages(e.target.valueAsNumber)} />
            </label>
            <label className="field">
              Độ sâu
              <input type="number" min={0} max={5} required value={depth} onChange={(e) => setDepth(e.target.valueAsNumber)} />
            </label>
            <label className="field">
              Concurrency
              <input type="number" min={1} max={5} required value={concurrency} onChange={(e) => setConcurrency(e.target.valueAsNumber)} />
            </label>
          </div>
        )}
        <label className="field" style={{ maxWidth: 260 }}>
          Delay giữa các request (ms)
          <input type="number" min={0} max={10000} step={100} required value={delayMs} onChange={(e) => setDelayMs(e.target.valueAsNumber)} />
        </label>
      </fieldset>

      <fieldset>
        <legend>Đăng nhập</legend>
        <div className="row">
          {AUTH_MODES.map(([value, label]) => (
            <label key={value} className="row">
              <input type="radio" name="auth" checked={authMode === value} onChange={() => setAuthMode(value)} />
              {label}
            </label>
          ))}
        </div>
        {authMode === "auto" && (
          <div className="grid-3">
            <label className="field">
              Tài khoản
              <input required autoComplete="off" value={user} onChange={(e) => setUser(e.target.value)} />
            </label>
            <label className="field">
              Mật khẩu
              <input required type="password" autoComplete="off" value={pass} onChange={(e) => setPass(e.target.value)} />
            </label>
            <label className="row">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Ghi nhớ
            </label>
          </div>
        )}
        {authMode === "auto" && (
          <details>
            <summary>Selector form đăng nhập (tùy chọn)</summary>
            <div className="grid-3">
              {(["user", "pass", "submit"] as const).map((k) => (
                <label key={k} className="field">
                  Selector {k === "user" ? "ô tài khoản" : k === "pass" ? "ô mật khẩu" : "nút gửi"}
                  <input className="mono" maxLength={500} placeholder="CSS selector" value={selectors[k]} onChange={(e) => setSelectors({ ...selectors, [k]: e.target.value })} />
                </label>
              ))}
            </div>
          </details>
        )}
      </fieldset>

      <div className="grid-3">
        <label className="field">
          Ngưỡng QA (%)
          <input type="number" min={0} max={100} required value={threshold} onChange={(e) => setThreshold(e.target.valueAsNumber)} />
        </label>
        <label className="field">
          Ngân sách token
          <input type="number" min={1} step={1} placeholder="mặc định" value={tokenBudget} onChange={(e) => setTokenBudget(e.target.value)} />
        </label>
      </div>

      <fieldset>
        <legend>Output</legend>
        <div className="row">
          <label className="row">
            <input type="radio" name="output" defaultChecked />
            HTML
          </label>
          {SP2_OUTPUTS.map((o) => (
            <label key={o} className="row muted">
              <input type="radio" name="output" disabled />
              {o} (SP2)
            </label>
          ))}
        </div>
      </fieldset>

      {msg && (
        <p className="alert" role="alert">
          {msg}
          {created && (
            <>
              {" — "}
              <Link href={`/p/${created}/sitemap`}>mở sitemap của dự án đã tạo</Link>
            </>
          )}
        </p>
      )}
      {loginFirst && created ? (
        <div className="card stack" role="group" aria-label="Đăng nhập trước khi quét">
          <span>Mở cửa sổ Chrome, đăng nhập (tự xử lý CAPTCHA nếu có), rồi bấm Quét trang — cửa sổ sẽ được đóng trước khi quét.</span>
          <div className="row">
            <button type="button" className="btn" disabled={busy} onClick={() => void run(() => api(`/api/projects/${created}/auth/open`, { method: "POST" }).then(() => setBusy(false)))}>
              Mở cửa sổ đăng nhập
            </button>
            <button type="button" className="btn primary" disabled={busy} onClick={() => void run(() => crawl(created))}>
              Quét trang
            </button>
          </div>
        </div>
      ) : (
        <div>
          <button className="btn primary" disabled={busy}>
            {busy ? "Đang quét…" : "Quét trang"}
          </button>
        </div>
      )}
    </form>
  );
}
