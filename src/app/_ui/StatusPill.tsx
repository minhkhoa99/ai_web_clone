import { Icon, type IconName } from "./Icon";

// Spec §4 statuses: the text is always the status code, color + icon only support it.
const LOOK: Record<string, { tone: string; icon?: IconName }> = {
  draft: { tone: "neutral", icon: "draft" },
  running: { tone: "primary" },
  paused: { tone: "neutral", icon: "pause_circle" },
  interrupted: { tone: "warn", icon: "warning" },
  needs_auth: { tone: "warn", icon: "lock" },
  failed: { tone: "danger", icon: "cancel" },
  completed: { tone: "success", icon: "check_circle" },
};

// queued: waiting in the job queue behind another project (the status is still the pre-run one)
export function StatusPill({ status, queued = false, ...ui }: { status: string; queued?: boolean; "data-ui"?: string }) {
  const look = LOOK[status] ?? { tone: "neutral" };
  return (
    <span className="pill-group" data-ui={ui["data-ui"]}>
      <span className={`pill tint tone-${look.tone}`} data-status={status}>
        {look.icon ? <Icon name={look.icon} size={14} /> : <span className={`dot${status === "running" ? " ping" : ""}`} aria-hidden="true" />}
        {status}
      </span>
      {queued && (
        <span className="pill tint tone-primary">
          <Icon name="schedule" size={14} />
          đang chờ
        </span>
      )}
    </span>
  );
}
