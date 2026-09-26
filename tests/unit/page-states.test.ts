import { expect, test } from "vitest";
import type { StampedEvent } from "@/core/jobs-base";
import { describe as lineOf, pageStates, runSpan, spanAfter, stateLabel, type TaskView } from "@/app/p/[id]/page-states";

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
