import type { ReactNode } from "react";

export function StatTile({ label, value, tone, ...ui }: { label: string; value: ReactNode; tone?: "warn"; "data-ui"?: string }) {
  return (
    <div className={`stat-tile${tone ? ` tone-${tone}` : ""}`} data-ui={ui["data-ui"]}>
      <span className="t-label-sm stat-label">{label}</span>
      <span className="t-label-md stat-value">{value}</span>
    </div>
  );
}
