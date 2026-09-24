const DROP = /^(utm_|fbclid$|gclid$|mc_)/;
const ASSET = /\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|json|xml|pdf|zip|mp4|webm|woff2?|ttf|eot|map)$/i;

export function normalizeUrl(raw: string, base?: string): string | null {
  let u: URL;
  try {
    u = new URL(raw, base);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  if (u.pathname !== "/" && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
  const keep = [...u.searchParams.entries()].filter(([k]) => !DROP.test(k)).sort();
  u.search = "";
  for (const [k, v] of keep) u.searchParams.append(k, v);
  return u.toString();
}

export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

export function isHtmlLike(url: string): boolean {
  try {
    return !ASSET.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

// The one slug of a page path, for page ids (jobs) and page file names (emit): "/" -> "", "/a/b" -> "a-b",
// "/x.html" -> "x", "/p?q=1" -> "p-q-1". Callers pick the empty-slug name and the case rule.
export function pathSlug(path: string): string {
  return path
    .replace(/\.html?(?=$|\?)/i, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
