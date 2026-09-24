import type { ReactNode } from "react";

export function Badge({ tone = "neutral", title, children, ...ui }: { tone?: "neutral" | "primary" | "success" | "warn" | "danger" | "accent"; title?: string; children: ReactNode; "data-ui"?: string }) {
  return (
    <span className={`badge tint tone-${tone}`} title={title} data-ui={ui["data-ui"]}>
      {children}
    </span>
  );
}
