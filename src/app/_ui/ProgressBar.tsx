const TONE: Record<string, string> = { running: "primary", needs_auth: "warn", interrupted: "warn", failed: "danger", completed: "success" };

export function ProgressBar({ value, status, label, ...ui }: { value: number; status: string; label: string; "data-ui"?: string }) {
  const v = Math.min(100, Math.max(0, value));
  return (
    <div className={`progress tone-${TONE[status] ?? "neutral"}`} role="progressbar" aria-label={label} aria-valuenow={v} aria-valuemin={0} aria-valuemax={100} data-ui={ui["data-ui"]}>
      <span style={{ width: `${v}%` }} />
    </div>
  );
}
