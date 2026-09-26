"use client";
import { useRef, useState } from "react";
import { api, errorText } from "@/app/_ui/api";
import { Button } from "@/app/_ui/Button";
import { downloadZip } from "@/app/_ui/download";
import { Field } from "@/app/_ui/Field";
import { Icon } from "@/app/_ui/Icon";

// Header actions: strip ids, "Xuất ra thư mục" popover (absolute path, required by the API), "Xuất ZIP".
export function ExportPanel({ projectId, disabled }: { projectId: string; disabled: boolean }) {
  const [dest, setDest] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [stripIds, setStripIds] = useState(false);
  const pop = useRef<HTMLDetailsElement>(null);

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
      const r = await api<{ dest: string }>(`/api/projects/${projectId}/export`, { body: { mode: "folder", dest, stripIds } });
      if (pop.current) pop.current.open = false;
      return `Đã xuất ra ${r.dest}`;
    });

  return (
    <div className="export-actions">
      <label className="check" data-ui="ui_code_viewer_strip_ids">
        <input type="checkbox" checked={stripIds} onChange={(e) => setStripIds(e.target.checked)} />
        Bỏ data-ir-id
      </label>
      <details
        ref={pop}
        className="popover"
        data-ui="ui_code_viewer_export_folder"
        onKeyDown={(e) => {
          if (e.key !== "Escape" || !pop.current) return;
          pop.current.open = false;
          pop.current.querySelector("summary")?.focus();
        }}
      >
        <summary className="btn btn-secondary" aria-disabled={disabled || undefined} onClick={(e) => disabled && e.preventDefault()}>
          <Icon name="drive_folder_upload" />
          Xuất ra thư mục
        </summary>
        <div className="popover-body">
          <Field label="Thư mục đích (đường dẫn tuyệt đối)">
            <input className="mono" value={dest} onChange={(e) => setDest(e.target.value)} placeholder={"D:\\exports\\site"} />
          </Field>
          <Button variant="primary" disabled={disabled || busy || !dest} onClick={() => void folder()}>
            Xuất
          </Button>
        </div>
      </details>
      <Button data-ui="ui_code_viewer_export_zip" variant="primary" icon="folder_zip" disabled={disabled || busy} onClick={() => void zip()}>
        Xuất ZIP
      </Button>
      {msg && (
        <p className={`note tint tone-${msg.ok ? "success" : "danger"}`} role={msg.ok ? "status" : "alert"}>
          {msg.text}
        </p>
      )}
    </div>
  );
}
