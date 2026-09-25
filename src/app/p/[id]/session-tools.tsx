"use client";
import { useState, type ChangeEvent } from "react";
import { api, errorText } from "@/app/_ui/api";
import { Banner } from "@/app/_ui/Banner";
import { Button } from "@/app/_ui/Button";
import { Icon } from "@/app/_ui/Icon";
import { IconButton } from "@/app/_ui/IconButton";

// A bare cookie array (browser extension export) or a Playwright storageState, applied into the project profile.
export async function importSessionFile(projectId: string, file: File): Promise<string> {
  const raw = JSON.parse(await file.text()) as unknown;
  const storageState = Array.isArray(raw) ? { cookies: raw } : raw;
  const r = await api<{ cookies: number; origins: number }>(`/api/projects/${projectId}/session/import`, { body: { storageState } });
  return `Đã import ${r.cookies} cookie, ${r.origins} origin.`;
}

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
    if (file) void run(() => importSessionFile(projectId, file));
  };

  return (
    <section className="session-tools" aria-label="Phiên đăng nhập">
      <div className="row">
        {/* aria-label/title even though the button has visible text: it sits inside a closed <details>, where
            innerText reads empty while collapsed, so the icon+text check needs an explicit accessible name. */}
        <Button icon="delete" disabled={busy} onClick={clear} aria-label="Xóa phiên" title="Xóa phiên">
          Xóa phiên
        </Button>
        <label className={`btn btn-secondary file-btn${busy ? " btn-disabled-look" : ""}`}>
          <Icon name="drive_folder_upload" />
          Import cookie / storageState JSON
          <input type="file" accept="application/json,.json" className="visually-hidden" disabled={busy} onChange={importFile} />
        </label>
      </div>
      {msg && (
        <Banner
          tone={msg.ok ? "info" : "danger"}
          icon={msg.ok ? "check_circle" : "error"}
          role={msg.ok ? "status" : "alert"}
          actions={<IconButton icon="close" label="Đóng thông báo" onClick={() => setMsg(null)} />}
        >
          {msg.text}
        </Banner>
      )}
    </section>
  );
}
