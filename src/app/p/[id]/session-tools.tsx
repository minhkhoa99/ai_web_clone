"use client";
import { useState, type ChangeEvent } from "react";
import { api, errorText } from "@/app/_ui/api";

// The project's browser session (spec §3): clear it, or import a cookie / storageState JSON export into it.
export function SessionTools({ projectId }: { projectId: string }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ ok: true, text: await fn() });
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const clear = () => {
    if (!confirm("Xóa phiên đăng nhập (cookie, localStorage) của dự án này?")) return;
    void run(async () => {
      await api(`/api/projects/${projectId}/session/clear`, { method: "POST" });
      return "Đã xóa phiên.";
    });
  };

  const importFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // the same file can be picked again
    if (!file) return;
    void run(async () => {
      const raw = JSON.parse(await file.text()) as unknown;
      // a bare cookie array (browser extension export) or a Playwright storageState
      const storageState = Array.isArray(raw) ? { cookies: raw } : raw;
      const r = await api<{ cookies: number; origins: number }>(`/api/projects/${projectId}/session/import`, { body: { storageState } });
      return `Đã import ${r.cookies} cookie, ${r.origins} origin.`;
    });
  };

  return (
    <section className="card stack" aria-label="Phiên đăng nhập">
      <div className="row">
        <button className="btn" disabled={busy} onClick={clear}>
          Xóa phiên
        </button>
        <label className="field">
          Import cookie / storageState JSON
          <input type="file" accept="application/json,.json" disabled={busy} onChange={importFile} />
        </label>
      </div>
      {msg && (
        <p className={msg.ok ? "notice" : "alert"} role={msg.ok ? "status" : "alert"}>
          {msg.text}
        </p>
      )}
    </section>
  );
}
