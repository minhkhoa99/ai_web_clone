"use client";
import { useState } from "react";
import { api, errorText } from "@/app/_ui/api";
import { downloadZip } from "@/app/_ui/download";

export function ExportPanel({ projectId, disabled }: { projectId: string; disabled: boolean }) {
  const [dest, setDest] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [stripIds, setStripIds] = useState(false);
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

  const zip = () =>
    run(async () => {
      await downloadZip(projectId, stripIds);
      return "Đã tải ZIP.";
    });

  const folder = () =>
    run(async () => {
      const r = await api<{ dest: string }>(path, { body: { mode: "folder", dest, stripIds } });
      return `Đã xuất ra ${r.dest}`;
    });

  return (
    <div className="card stack">
      <label className="row">
        <input type="checkbox" checked={stripIds} onChange={(e) => setStripIds(e.target.checked)} />
        Bỏ data-ir-id
      </label>
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
