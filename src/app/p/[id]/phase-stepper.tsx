// The 9 spec §4 phases. `assets` runs inside capture (R49), so it mirrors capture's state.
import { Icon, type IconName } from "@/app/_ui/Icon";

export const PHASES = ["discover", "capture", "assets", "ir", "name", "emit", "qa", "fix", "done"] as const;
type Phase = (typeof PHASES)[number];
type StepState = "pending" | "active" | "done" | "error";
export type TaskLike = { phase: string; status: string };

const LABEL: Record<StepState, string> = { pending: "chờ", active: "đang chạy", done: "xong", error: "lỗi" };

const ICON: Record<Phase, IconName> = {
  discover: "radar",
  capture: "photo_camera",
  assets: "image",
  ir: "schema",
  name: "badge",
  emit: "code",
  qa: "difference",
  fix: "auto_fix_high",
  done: "task_alt",
};

function stateOf(tasks: TaskLike[], phase: string): StepState {
  const own = tasks.filter((t) => t.phase === phase);
  if (own.length === 0) return "pending";
  if (own.some((t) => t.status === "running")) return "active";
  if (own.some((t) => t.status === "failed" || t.status === "needs_auth")) return "error";
  if (own.every((t) => t.status === "done")) return "done";
  return own.some((t) => t.status === "done") ? "active" : "pending";
}

export function phaseStates(tasks: TaskLike[], status: string): Record<Phase, StepState> {
  if (status === "completed") return Object.fromEntries(PHASES.map((p) => [p, "done"])) as Record<Phase, StepState>;
  const states = Object.fromEntries(PHASES.map((p) => [p, stateOf(tasks, p)])) as Record<Phase, StepState>;
  states.assets = states.capture;
  // qa finished without failing sections: there is nothing to fix
  if (states.qa === "done" && !tasks.some((t) => t.phase === "fix")) states.fix = "done";
  return states;
}

export function PhaseStepper({ states }: { states: Record<Phase, StepState> }) {
  return (
    <ol className="stepper-x" aria-label="Các pha" data-ui="ui_progress_phase_stepper">
      {PHASES.map((p) => {
        const s = states[p];
        return (
          <li key={p} className={`step step-${s}`} data-state={s} aria-current={s === "active" ? "step" : undefined} title={LABEL[s]}>
            <span className="step-icon">
              <Icon name={s === "done" ? "check" : s === "error" ? "error" : ICON[p]} />
              {s === "active" && <span className="dot ping step-dot" aria-hidden="true" />}
            </span>
            <span className="step-name t-label-md">{p}</span>
          </li>
        );
      })}
    </ol>
  );
}
