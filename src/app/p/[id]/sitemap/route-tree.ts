// Sitemap tree (spec parity §3.4, D10), pure: one node per path segment. A virtual folder only for a prefix that is
// not itself a page and holds >= 2 pages (in >= 2 branches); a non-page prefix with a single branch is skipped (its
// rows are lifted). A page with sub-pages is their parent. No origin row: the origin is the chip in the page header.
export type RouteRow<P> = { kind: "folder" | "page"; key: string; path: string; depth: number; isLast: boolean; page?: P; urls: string[]; children: RouteRow<P>[] };

type Trie<P> = { prefix: string; page?: P; kids: Map<string, Trie<P>> };

export const pathOf = (url: string): string => {
  const u = new URL(url);
  return u.pathname + u.search;
};

const urlsOf = <P extends { url: string }>(n: Trie<P>): string[] => [...(n.page ? [n.page.url] : []), ...[...n.kids.values()].flatMap((k) => urlsOf(k))];
const markLast = <P>(rows: RouteRow<P>[]): RouteRow<P>[] => rows.map((r, i) => ({ ...r, isLast: i === rows.length - 1 }));

function rowsOf<P extends { url: string }>(node: Trie<P>, depth: number): RouteRow<P>[] {
  const out: RouteRow<P>[] = [];
  const kids = [...node.kids.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, k]) => k);
  for (const kid of kids) {
    if (kid.page) out.push({ kind: "page", key: kid.prefix, path: kid.prefix, depth, isLast: false, page: kid.page, urls: [kid.page.url], children: rowsOf(kid, depth + 1) });
    // >= 2 branches below a non-page prefix = >= 2 pages (every leaf is a page); a single branch is lifted, so a chain
    // like /a -> /a/b collapses into one folder "/a/b"
    else if (kid.kids.size >= 2) out.push({ kind: "folder", key: kid.prefix, path: kid.prefix, depth, isLast: false, urls: urlsOf(kid), children: rowsOf(kid, depth + 1) });
    else out.push(...rowsOf(kid, depth));
  }
  return markLast(out);
}

export function buildRouteTree<P extends { url: string }>(pages: P[]): RouteRow<P>[] {
  const root: Trie<P> = { prefix: "", kids: new Map() };
  for (const p of pages) {
    const u = new URL(p.url);
    const segs = u.pathname.split("/").filter(Boolean);
    let node = root;
    segs.forEach((seg, i) => {
      let next = node.kids.get(seg);
      if (!next) {
        next = { prefix: `/${segs.slice(0, i + 1).join("/")}`, kids: new Map() };
        node.kids.set(seg, next);
      }
      node = next;
    });
    if (u.search) {
      const leaf: Trie<P> = { prefix: u.pathname + u.search, page: p, kids: new Map() };
      node.kids.set(u.search, leaf);
    } else if (node.page) {
      node.kids.set(`#${pathOf(p.url)}`, { prefix: pathOf(p.url), page: p, kids: new Map() }); // "/a" and "/a/": both kept
    } else node.page = p;
  }
  const home: RouteRow<P>[] = root.page ? [{ kind: "page", key: "/", path: "/", depth: 0, isLast: false, page: root.page, urls: [root.page.url], children: [] }] : [];
  return markLast([...home, ...rowsOf(root, 0)]);
}

// Matching pages and the rows above them; a folder's urls shrink to the matching ones (its checkbox acts on those).
export function filterTree<P extends { url: string }>(rows: RouteRow<P>[], keep: (url: string) => boolean): RouteRow<P>[] {
  const out: RouteRow<P>[] = [];
  for (const r of rows) {
    const children = filterTree(r.children, keep);
    const self = r.kind === "page" && r.page !== undefined && keep(r.page.url);
    if (self || children.length > 0) out.push({ ...r, children, urls: r.kind === "folder" ? r.urls.filter(keep) : r.urls });
  }
  return markLast(out);
}

export const visibleRows = <P>(rows: RouteRow<P>[], closed: Set<string>): RouteRow<P>[] => rows.flatMap((r) => [r, ...(closed.has(r.key) ? [] : visibleRows(r.children, closed))]);

export const parentKeys = <P>(rows: RouteRow<P>[]): string[] => rows.flatMap((r) => (r.children.length ? [r.key, ...parentKeys(r.children)] : []));

export function selectionState(urls: string[], selected: Set<string>): "all" | "some" | "none" {
  const n = urls.filter((u) => selected.has(u)).length;
  return n === 0 ? "none" : n === urls.length ? "all" : "some";
}

export function httpLabel(p: { status?: number | null; loadMs?: number; redirected?: boolean }): { text: string; tone: "neutral" | "success" | "warn" | "danger" } {
  if (p.status === undefined || p.status === null) return { text: "—", tone: "neutral" };
  if (p.redirected || (p.status >= 300 && p.status < 400)) return { text: `${p.status} · chuyển hướng`, tone: "neutral" };
  const text = `${p.status} · ${((p.loadMs ?? 0) / 1000).toFixed(1).replace(".", ",")} s`;
  if (p.status < 300) return { text, tone: "success" };
  return { text, tone: p.status === 401 || p.status === 403 ? "warn" : "danger" };
}
