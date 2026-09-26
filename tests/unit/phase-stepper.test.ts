import { expect, test } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PhaseStepper, phaseStates } from "@/app/p/[id]/phase-stepper";

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

test("PhaseStepper: every step names its state for screen readers (visually hidden, not just a colour/icon/title)", () => {
  const states = phaseStates([{ phase: "discover", status: "done" }, { phase: "capture", status: "running" }, { phase: "ir", status: "failed" }], "running");
  const html = renderToStaticMarkup(h(PhaseStepper, { states }));
  const said = [...html.matchAll(/<span class="visually-hidden">([^<]*)<\/span>/g)].map((m) => m[1]);
  expect(said).toEqual([" — xong", " — đang chạy", " — đang chạy", " — lỗi", " — chờ", " — chờ", " — chờ", " — chờ", " — chờ"]);
});
