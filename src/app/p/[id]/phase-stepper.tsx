// The 9 spec §4 phases. `assets` runs inside capture (R49), so it mirrors capture's state.
export const PHASES = ["discover", "capture", "assets", "ir", "name", "emit", "qa", "fix", "done"] as const;
type Phase = (typeof PHASES)[number];
type StepState = "pending" | "active" | "done" | "error";
export type TaskLike = { phase: string; status: string };

const LABEL: Record<StepState, string> = { pending: "chờ", active: "đang chạy", done: "xong", error: "lỗi" };

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
    <ol className="stepper" aria-label="Các pha">
      {PHASES.map((p) => (
        <li key={p} className={states[p]} aria-current={states[p] === "active" ? "step" : undefined} title={LABEL[states[p]]}>
          {states[p] === "done" ? "✓ " : states[p] === "error" ? "! " : ""}
          {p}
        </li>
      ))}
    </ol>
  );
}
