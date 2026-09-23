import { expect, test } from "vitest";
import { phaseStates } from "@/app/p/[id]/phase-stepper";

test("phaseStates: assets mirrors capture, fix done when qa passed without fix tasks, completed = all done", () => {
  const tasks = [
    { phase: "discover", status: "done" },
    { phase: "capture", status: "done" },
    { phase: "capture", status: "running" },
    { phase: "ir", status: "pending" },
  ];
  const s = phaseStates(tasks, "running");
  expect([s.discover, s.capture, s.assets, s.ir, s.done]).toEqual(["done", "active", "active", "pending", "pending"]);
  expect(phaseStates([{ phase: "capture", status: "needs_auth" }], "needs_auth").capture).toBe("error");
  expect(phaseStates([{ phase: "qa", status: "done" }], "running").fix).toBe("done");
  expect(phaseStates([{ phase: "qa", status: "done" }, { phase: "fix", status: "pending" }], "running").fix).toBe("pending");
  expect(Object.values(phaseStates([], "completed")).every((v) => v === "done")).toBe(true);
});
