"use client";
import { useState } from "react";
import { api, errorText } from "@/app/_ui/api";

export function ExportPanel({ projectId, disabled }: { projectId: string; disabled: boolean }) {
  const [dest, setDest] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const path = `/api/projects/${projectId}/export`;

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

  // The zip is a POST (JSON body, CSRF guard), so it is downloaded via a blob URL rather than a plain link.
  const zip = () =>
    run(async () => {
      const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "zip" }) });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
        throw new Error(`${err.code ?? res.status}: ${err.message ?? res.statusText}`);
      }
      const href = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement("a"), { href, download: `${projectId}.zip` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(href), 10_000); // after the download has started
      return "Đã tải ZIP.";
    });

  const folder = () =>
    run(async () => {
      const r = await api<{ dest: string }>(path, { body: { mode: "folder", dest } });
      return `Đã xuất ra ${r.dest}`;
    });

  return (
    <div className="card stack">
      <div className="row">
        <button className="btn primary" disabled={disabled || busy} onClick={() => void zip()}>
          Xuất ZIP
        </button>
        <label className="field" style={{ flex: 1 }}>
          Thư mục đích (đường dẫn tuyệt đối)
          <input className="mono" value={dest} onChange={(e) => setDest(e.target.value)} placeholder={"D:\\exports\\site"} />
        </label>
        <button className="btn" disabled={disabled || busy || !dest} onClick={() => void folder()}>
          Xuất ra thư mục
        </button>
      </div>
      {msg && (
        <p className={msg.ok ? "notice" : "alert"} role={msg.ok ? "status" : "alert"}>
          {msg.text}
        </p>
      )}
    </div>
  );
}
