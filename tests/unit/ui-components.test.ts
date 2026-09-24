import { expect, test } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GridTable } from "@/app/_ui/GridTable";
import { IconButton } from "@/app/_ui/IconButton";
import { PageHeader } from "@/app/_ui/PageHeader";
import { ProgressBar } from "@/app/_ui/ProgressBar";
import { SegmentedControl } from "@/app/_ui/SegmentedControl";
import { StatusPill } from "@/app/_ui/StatusPill";

const STATUSES = ["draft", "running", "paused", "interrupted", "needs_auth", "failed", "completed"];

test("StatusPill: text is always the status code; running pings, the 6 others carry an icon; queued adds 'đang chờ'", () => {
  for (const s of STATUSES) {
    const html = renderToStaticMarkup(h(StatusPill, { status: s }));
    expect(html).toContain(`>${s}</span>`);
    expect(html.includes("ping")).toBe(s === "running");
    expect(html.includes("<svg")).toBe(s !== "running");
  }
  expect(renderToStaticMarkup(h(StatusPill, { status: "draft", queued: true }))).toContain("đang chờ");
  expect(renderToStaticMarkup(h(StatusPill, { status: "failed", "data-ui": "x" }))).toContain('data-ui="x"');
});

test("IconButton names itself: aria-label + title from the required label", () => {
  const html = renderToStaticMarkup(h(IconButton, { icon: "delete", label: "Xóa", tone: "danger" }));
  expect(html).toContain('aria-label="Xóa"');
  expect(html).toContain('title="Xóa"');
  expect(html).toContain("tone-danger");
  expect(html).toContain('type="button"');
});

test("GridTable: ARIA table roles, grid template from the widths, row tone", () => {
  const html = renderToStaticMarkup(
    h(GridTable<{ id: string; warn: boolean }>, {
      label: "T",
      columns: [{ key: "a", header: "A", width: "120px" }, { key: "b", header: "B", width: "minmax(0, 1fr)" }],
      rows: [{ id: "1", warn: true }, { id: "2", warn: false }],
      rowKey: (r) => r.id,
      renderCell: (r, k) => `${k}${r.id}`,
      rowTone: (r) => (r.warn ? "warn" : undefined),
    }),
  );
  expect(html).toContain('role="table"');
  expect(html.match(/role="row"/g)).toHaveLength(3);
  expect(html.match(/role="columnheader"/g)).toHaveLength(2);
  expect(html.match(/role="cell"/g)).toHaveLength(4);
  expect(html).toContain("grid-template-columns:120px minmax(0, 1fr)");
  expect(html.match(/row-warn/g)).toHaveLength(1);
});

test("PageHeader: breadcrumb nav, last crumb aria-current, h1 title", () => {
  const html = renderToStaticMarkup(h(PageHeader, { crumbs: [{ label: "Lịch sử" }, { label: "Sitemap" }], title: "Chọn trang để clone" }));
  expect(html).toContain('aria-label="Breadcrumb"');
  expect(html).toContain('<span aria-current="page">Sitemap</span>');
  expect(html).toMatch(/<h1 class="t-headline-lg">Chọn trang để clone<\/h1>/);
});

test("SegmentedControl: tabs = tablist/tab/aria-selected with a count badge; toggle = group/aria-pressed", () => {
  const tabs = renderToStaticMarkup(
    h(SegmentedControl<"a" | "b">, { label: "L", semantics: "tabs", value: "a", onChange: () => {}, options: [{ value: "a", label: "A", count: 4 }, { value: "b", label: "B", count: 1 }] }),
  );
  expect(tabs).toContain('role="tablist"');
  expect(tabs.match(/role="tab"/g)).toHaveLength(2);
  expect(tabs).toContain('aria-selected="true"');
  expect(tabs).toContain("tone-accent");
  const toggle = renderToStaticMarkup(h(SegmentedControl<"a" | "b">, { label: "L", value: "b", onChange: () => {}, options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }));
  expect(toggle).toContain('role="group"');
  expect(toggle).toContain('aria-pressed="true"');
});

test("ProgressBar: progressbar role and the status color", () => {
  for (const [status, tone] of [["running", "primary"], ["needs_auth", "warn"], ["interrupted", "warn"], ["failed", "danger"], ["completed", "success"], ["paused", "neutral"]]) {
    const html = renderToStaticMarkup(h(ProgressBar, { value: 42, status: status!, label: "Tiến độ" }));
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="42"');
    expect(html).toContain(`tone-${tone}`);
  }
});
