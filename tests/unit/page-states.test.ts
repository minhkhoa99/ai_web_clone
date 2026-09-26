import { expect, test } from "vitest";
import type { StampedEvent } from "@/core/jobs-base";
import { describe as lineOf, errorRows, pageStates, reasonOf, runSpan, spanAfter, stateLabel, withTaskEvent, type TaskView } from "@/app/p/[id]/page-states";
import { ERROR_HINTS } from "@/app/_ui/error-hints";

const t = (phase: string, key: string, status: string, errorCode: string | null = null): TaskView => ({ phase, key, status, errorCode });
const pages = ["home", "a", "b", "c", "d", "e", "f"].map((pageId) => ({ pageId, url: `http://x.test/${pageId === "home" ? "" : pageId}?q=1` }));

test("pageStates: needs_auth > running > failed capture (skip codes -> skipped) > done (capture + name) > pending", () => {
  const states = pageStates(
    [
      t("capture", "home", "done"), t("name", "home", "done"),
      t("capture", "a", "needs_auth", "AUTH_REQUIRED"), t("name", "a", "running"),
      t("capture", "b", "done"), t("name", "b", "done"), t("fix", "b:sec-1", "running"),
      t("capture", "c", "failed", "NAV_TIMEOUT"),
      t("capture", "d", "failed", "ROBOTS_DISALLOWED"),
      t("capture", "e", "done"), t("name", "e", "pending"),
      t("ir", "all", "pending"), t("qa", "all", "pending"),
    ],
    pages,
  );
  expect(states.map((s) => [s.pageId, s.state, s.phase ?? s.code ?? ""])).toEqual([
    ["home", "done", ""],
    ["a", "needs_auth", ""],
    ["b", "running", "fix"],
    ["c", "failed", "NAV_TIMEOUT"],
    ["d", "skipped", "ROBOTS_DISALLOWED"],
    ["e", "pending", ""],
    ["f", "pending", ""],
  ]);
  expect(states[0]?.path).toBe("/?q=1");
  expect(states.map(stateLabel)).toEqual(["xong", "cần đăng nhập", "đang chạy · fix", "lỗi · NAV_TIMEOUT", "bỏ qua · ROBOTS_DISALLOWED", "chờ", "chờ"]);
  // capture done and no name task (e.g. a capture-only view) is done
  expect(pageStates([t("capture", "home", "done")], pages.slice(0, 1))[0]?.state).toBe("done");
});

test("run clock: the last `running` status starts it, the next status ends it", () => {
  const ev = (status: string, at: number) => ({ type: "status", status, at }) as StampedEvent;
  const log = { type: "log", level: "info", message: "x", at: 20 } as StampedEvent;
  expect(runSpan([])).toEqual({ start: null, end: null });
  expect(runSpan([ev("running", 10), log, ev("completed", 50)])).toEqual({ start: 10, end: 50 });
  expect(runSpan([ev("running", 10), ev("paused", 30), ev("running", 60)])).toEqual({ start: 60, end: null });
  expect(spanAfter({ start: 60, end: null }, ev("failed", 90))).toEqual({ start: 60, end: 90 });
  expect(spanAfter({ start: 60, end: 90 }, ev("interrupted", 99))).toEqual({ start: 60, end: 90 });
});

test("log lines: text as before (describe), progress is not a line", () => {
  expect(lineOf({ type: "task", phase: "capture", key: "home", status: "failed", errorCode: "NAV_TIMEOUT", error: "boom", at: 1 })).toEqual({ level: "error", text: "[capture] home → failed — NAV_TIMEOUT: boom" });
  expect(lineOf({ type: "status", status: "completed", at: 1 })).toEqual({ level: "info", text: "trạng thái → completed" });
  expect(lineOf({ type: "progress", progress: 5, tokensUsed: 0, at: 1 })).toBeNull();
});

test("pageStates: a failed name/fix task, or one done with an AI-stop / budget / AI-error marker, makes the page lỗi (hardening §4)", () => {
  const ps = ["p1", "p2", "p3", "p4", "p5", "p6"].map((pageId) => ({ pageId, url: `http://x.test/${pageId}` }));
  const ok = (p: string) => [t("capture", p, "done"), t("name", p, "done")];
  const states = pageStates(
    [
      ...ok("p1"), t("fix", "p1:hero", "done", "AI_QUOTA"),
      ...ok("p2"), t("fix", "p2:hero", "failed", "BROWSER_CRASH"),
      t("capture", "p3", "done"), t("name", "p3", "done", "AI_BAD_RESPONSE"),
      ...ok("p4"), t("fix", "p4:a", "done"), t("fix", "p4:b", "done", "BUDGET_EXCEEDED"),
      ...ok("p5"), t("fix", "p5:a", "done"),
      ...ok("p6"), t("fix", "p6:a", "done", "IR_PATCH_INVALID"), // not a marker of trouble: still xong
    ],
    ps,
  );
  expect(states.map((s) => [s.state, s.code ?? ""])).toEqual([
    ["failed", "AI_QUOTA"],
    ["failed", "BROWSER_CRASH"],
    ["failed", "AI_BAD_RESPONSE"],
    ["failed", "BUDGET_EXCEEDED"],
    ["done", ""],
    ["done", ""],
  ]);
  expect(stateLabel(states[0]!)).toBe("lỗi · AI_QUOTA");
});

test("errorRows: tasks with an error code, failed first then in load (rowid) order", () => {
  const rows = errorRows([
    t("capture", "home", "done"),
    t("fix", "home:hero", "done", "AI_QUOTA"),
    t("capture", "blocked", "failed", "ROBOTS_DISALLOWED"),
    t("name", "home", "done", "AI_BAD_RESPONSE"),
    t("qa", "all", "failed", "BROWSER_CRASH"),
  ]);
  expect(rows.map((r) => `${r.phase}:${r.key}`)).toEqual(["capture:blocked", "qa:all", "fix:home:hero", "name:home"]);
});

test("reasonOf: the banner's code, hint and the latest message of that code; a free-text reason has no hint", () => {
  const tasks = [
    { ...t("fix", "home:a", "done", "AI_QUOTA"), errorMsg: "first 402" },
    { ...t("fix", "home:b", "done", "AI_QUOTA"), errorMsg: "latest 402" },
    { ...t("fix", "home:c", "done", "AI_AUTH"), errorMsg: "401" },
  ];
  expect(reasonOf("AI_QUOTA", tasks)).toEqual({ title: `AI_QUOTA — ${ERROR_HINTS.AI_QUOTA}`, message: "latest 402" });
  expect(reasonOf("boom: disk full", tasks)).toEqual({ title: "boom: disk full", message: undefined });
  expect(reasonOf(null, tasks)).toBeNull();
});

test("withTaskEvent: a live SSE task event replaces its row, so the error panel shows the new code + message (hardening §4)", () => {
  const prev = new Map([["fix:home:s1", t("fix", "home:s1", "running")], ["capture:home", t("capture", "home", "done")]]);
  const ev = { type: "task", phase: "fix", key: "home:s1", status: "done", errorCode: "AI_QUOTA", error: "insufficient credit", at: 1 } as const;
  const next = withTaskEvent(prev, ev);
  expect(next).not.toBe(prev);
  expect(prev.get("fix:home:s1")?.status).toBe("running");
  expect(errorRows([...next.values()])).toEqual([{ phase: "fix", key: "home:s1", status: "done", errorCode: "AI_QUOTA", errorMsg: "insufficient credit" }]);
});
