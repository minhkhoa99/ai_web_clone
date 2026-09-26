"use client";
import { useState, type ReactNode } from "react";
import { Button } from "@/app/_ui/Button";
import { Icon } from "@/app/_ui/Icon";
import { IconButton } from "@/app/_ui/IconButton";

type Props = { projectId: string; file: string; size: string; lines: number | null; copyable: boolean; initialWrap: boolean; children: ReactNode };

// File header (chip, size, lines, Copy, wrap) + the server-highlighted code pane.
export function CodeFile({ projectId, file, size, lines, copyable, initialWrap, children }: Props) {
  const [wrap, setWrap] = useState(initialWrap);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const copy = async () => {
    setCopyFailed(false);
    try {
      const res = await fetch(`/api/projects/${projectId}/files/out/${file.split("/").map(encodeURIComponent).join("/")}`);
      if (!res.ok) throw new Error(String(res.status));
      await navigator.clipboard.writeText(await res.text());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyFailed(true);
      setTimeout(() => setCopyFailed(false), 3000);
    }
  };
  return (
    <>
      <div className="code-head" data-ui="ui_code_viewer_file_header">
        <span className="url-chip">
          <Icon name="description" />
          <span className="mono url-chip-text" title={`out/${file}`}>
            out/{file}
          </span>
        </span>
        <span className="code-stats t-label-sm text-3">
          <Icon name="data_object" size={14} />
          {size}
          {lines !== null && (
            <>
              <span aria-hidden="true">•</span>
              <Icon name="format_list_numbered" size={14} />
              {lines} dòng
            </>
          )}
        </span>
        <span className="code-head-actions">
          {copyFailed && (
            <span className="t-label-sm text-danger" role="alert">
              Không sao chép được
            </span>
          )}
          {copyable && (
            <Button data-ui="ui_code_viewer_copy_button" icon="content_copy" onClick={() => void copy()}>
              {copied ? "Đã sao chép" : "Sao chép"}
            </Button>
          )}
          <IconButton data-ui="ui_code_viewer_wrap_toggle" icon="wrap_text" label="Xuống dòng" pressed={wrap} onClick={() => setWrap((w) => !w)} />
        </span>
      </div>
      <div className={`code-pane${wrap ? " wrap" : ""}`} data-ui="ui_code_viewer_code_pane">
        {children}
      </div>
    </>
  );
}
