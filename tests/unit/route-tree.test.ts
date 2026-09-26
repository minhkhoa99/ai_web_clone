import { expect, test } from "vitest";
import { buildRouteTree, filterTree, httpLabel, parentKeys, pathOf, selectionState, visibleRows, type RouteRow } from "@/app/p/[id]/sitemap/route-tree";

const o = "http://x.test";
const pages = (paths: string[]) => paths.map((p) => ({ url: `${o}${p}` }));
const flat = <P,>(rows: RouteRow<P>[]) => visibleRows(rows, new Set()).map((r) => `${"  ".repeat(r.depth)}${r.kind === "folder" ? "+" : "-"}${r.path}${r.isLast ? " $" : ""}`);

test("D10: a virtual folder only for a non-page prefix with >= 2 pages; a single-page prefix is lifted; home is a sibling, no origin row", () => {
  expect(flat(buildRouteTree(pages(["/docs/b", "/", "/blog/post", "/about", "/docs/a"])))).toEqual([
    "-/",
    "-/about",
    "-/blog/post",
    "+/docs $",
    "  -/docs/a",
    "  -/docs/b $",
  ]);
});

test("a page with sub-pages is their parent; a query string is its own leaf; folder urls = every page below", () => {
  const tree = buildRouteTree(pages(["/pricing", "/pricing/team", "/?page=2", "/a/b/c", "/a/b/d"]));
  expect(flat(tree)).toEqual(["-/?page=2", "+/a/b", "  -/a/b/c", "  -/a/b/d $", "-/pricing $", "  -/pricing/team $"]);
  expect(tree.find((r) => r.kind === "folder")?.urls).toEqual([`${o}/a/b/c`, `${o}/a/b/d`]);
  expect(tree.find((r) => r.path === "/pricing")?.urls).toEqual([`${o}/pricing`]);
});

test("filterTree keeps matches and their ancestors; visibleRows hides closed branches; parentKeys lists every expandable row", () => {
  const tree = buildRouteTree(pages(["/", "/docs/a", "/docs/b", "/about"]));
  expect(flat(filterTree(tree, (u) => u.endsWith("/docs/b")))).toEqual(["+/docs $", "  -/docs/b $"]);
  expect(filterTree(tree, (u) => u.endsWith("/docs/b"))[0]?.urls).toEqual([`${o}/docs/b`]);
  expect(filterTree(tree, () => false)).toEqual([]);
  expect(visibleRows(tree, new Set(["/docs"])).map((r) => r.path)).toEqual(["/", "/about", "/docs"]);
  expect(parentKeys(tree)).toEqual(["/docs"]);
});

test("selectionState is the tri-state of a folder checkbox", () => {
  const sel = new Set(["a", "b"]);
  expect([selectionState(["a", "b"], sel), selectionState(["a", "c"], sel), selectionState(["c"], sel), selectionState([], sel)]).toEqual(["all", "some", "none", "none"]);
});

test("httpLabel: 2xx success with seconds, redirect text-2, 401/403 warn, other 4xx/5xx danger, no data '—'", () => {
  expect(httpLabel({ status: 200, loadMs: 1234, redirected: false })).toEqual({ text: "200 · 1,2 s", tone: "success" });
  expect(httpLabel({ status: 200, loadMs: 60, redirected: true })).toEqual({ text: "200 · chuyển hướng", tone: "neutral" });
  expect(httpLabel({ status: 401, loadMs: 40 }).tone).toBe("warn");
  expect(httpLabel({ status: 404, loadMs: 40 }).tone).toBe("danger");
  expect(httpLabel({ status: 503, loadMs: 40 }).tone).toBe("danger");
  expect(httpLabel({})).toEqual({ text: "—", tone: "neutral" }); // discover.json from before spec §4.4
  expect(httpLabel({ status: null })).toEqual({ text: "—", tone: "neutral" });
});

test("fix round 1 #14: '/a' and '/a/' don't collide — each row shows its own real path, keys stay unique", () => {
  // the trailing-slash variant arrives first and becomes the trie node's primary occupant: its row must still
  // show ITS OWN real path ("/a/"), not the segment-reconstructed "/a" the node itself is keyed by.
  const tree = buildRouteTree(pages(["/a/", "/a"]));
  const rows = visibleRows(tree, new Set());
  expect(rows.map((r) => r.path)).toEqual(["/a/", "/a"]);
  expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
});

test("fix round 1 #14: percent-encoded path segments are decoded, for the row label and for pathOf (search matches the decoded form)", () => {
  const tree = buildRouteTree(pages(["/caf%C3%A9/menu"]));
  expect(visibleRows(tree, new Set()).map((r) => r.path)).toEqual(["/café/menu"]);
  expect(pathOf(`${o}/caf%C3%A9/menu`)).toBe("/café/menu");
});

test("fix round 2 #5: an escaped literal slash (%2F) inside one segment stays encoded — it never collides with a real 2-segment path", () => {
  const tree = buildRouteTree(pages(["/a%2Fb", "/a/b"]));
  const rows = visibleRows(tree, new Set());
  expect(rows.map((r) => r.path).sort()).toEqual(["/a%2Fb", "/a/b"].sort()); // distinct rows, not merged into one "/a/b"
  expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  // other escapes in the same segment still decode normally around the preserved %2F
  expect(pathOf(`${o}/caf%C3%A9%2Fb`)).toBe("/café%2Fb");
});

test("100 pages build in < 50 ms", () => {
  const many = pages(Array.from({ length: 100 }, (_, i) => `/s${i % 10}/p${i}`));
  const t0 = performance.now();
  const tree = buildRouteTree(many);
  expect(performance.now() - t0).toBeLessThan(50);
  expect(visibleRows(tree, new Set()).filter((r) => r.kind === "page")).toHaveLength(100);
});
