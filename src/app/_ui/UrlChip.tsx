"use client";
import { useState, type ReactNode } from "react";
import { IconButton } from "./IconButton";

type Props = { url: string; openable?: boolean; copyable?: boolean; plain?: boolean; extra?: ReactNode; "data-ui"?: string };

export function UrlChip({ url, openable = false, copyable = false, plain = false, extra, ...ui }: Props) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  return (
    <span className={`url-chip${plain ? " url-chip-plain" : ""}`} data-ui={ui["data-ui"]}>
      <span className="mono url-chip-text" title={url}>
        {url}
      </span>
      {openable && <IconButton icon="open_in_new" label="Mở trang gốc trong tab mới" href={url} external />}
      {copyable && <IconButton icon="content_copy" label={copied ? "Đã sao chép" : "Sao chép URL"} onClick={copy} />}
      {extra}
    </span>
  );
}
