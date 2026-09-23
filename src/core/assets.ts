import { createHash, randomBytes } from "node:crypto";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { APIResponse, BrowserContext, Page, Response } from "playwright";
import type { CaptureNode } from "./capture";
import { AppError, Codes } from "./errors";
import { mapLimit } from "./limit";

// --- trackResponses -------------------------------------------------------

const NETWORK_ASSET_RESOURCE_TYPES = new Set(["image", "font", "media"]);

// Attach before navigation: records http(s) URLs of image/font/media
// responses (stylesheet-referenced images arrive as resourceType "image").
// stop() removes the listener — resource lifecycle owned by the caller.
export function trackResponses(page: Page): { urls(): string[]; stop(): void } {
  const found: string[] = [];
  const onResponse = (response: Response) => {
    const url = response.url();
    if (!NETWORK_ASSET_RESOURCE_TYPES.has(response.request().resourceType())) return;
    if (!url.startsWith("http:") && !url.startsWith("https:")) return;
    found.push(url);
  };
  page.on("response", onResponse);
  return {
    urls: () => found,
    stop: () => page.off("response", onResponse),
  };
}

// --- collectAssetUrls -------------------------------------------------------

const ICON_RELS = new Set(["icon", "apple-touch-icon"]);

function urlsFromCssValue(value: string | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  const re = /url\(\s*(['"]?)(.*?)\1\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) {
    if (m[2]) out.push(m[2]);
  }
  return out;
}

function urlsFromSrcset(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim().split(/\s+/)[0])
    .filter((u): u is string => !!u);
}

function isIconRel(rel: string | undefined): boolean {
  if (!rel) return false;
  return rel.toLowerCase().split(/\s+/).some((token) => ICON_RELS.has(token));
}

function collectFromNode(node: CaptureNode, out: string[]): void {
  const tag = node.tag.toLowerCase();
  const attrs = node.attrs;

  if (tag === "img") {
    if (attrs.src) out.push(attrs.src);
    out.push(...urlsFromSrcset(attrs.srcset));
  } else if (tag === "source") {
    out.push(...urlsFromSrcset(attrs.srcset));
    if (attrs.src) out.push(attrs.src);
  } else if (tag === "video") {
    if (attrs.src) out.push(attrs.src);
    if (attrs.poster) out.push(attrs.poster);
  } else if (tag === "link") {
    if (attrs.href && isIconRel(attrs.rel)) out.push(attrs.href);
  } else if (tag === "meta") {
    if (attrs.property === "og:image" && attrs.content) out.push(attrs.content);
  } else if (tag === "use") {
    const href = attrs.href ?? attrs["xlink:href"];
    const withoutFragment = href?.split("#")[0];
    if (withoutFragment) out.push(withoutFragment);
  }

  out.push(...urlsFromCssValue(node.style["background-image"]));
  if (node.pseudo?.before) out.push(...urlsFromCssValue(node.pseudo.before["background-image"]));
  if (node.pseudo?.after) out.push(...urlsFromCssValue(node.pseudo.after["background-image"]));

  for (const child of node.children) collectFromNode(child, out);
}

// PURE: resolves every asset reference found in the captured DOM (img/srcset,
// picture>source, video/poster, source[src], background-image incl. pseudo,
// favicon/apple-touch-icon links, og:image, svg <use> external refs) plus the
// network-observed URLs against baseUrl, drops non-http(s) (data:/blob:), and
// dedupes while keeping first-seen (deterministic) order.
export function collectAssetUrls(dom: CaptureNode, networkUrls: string[], baseUrl: string): string[] {
  const raw: string[] = [];
  collectFromNode(dom, raw);
  raw.push(...networkUrls);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of raw) {
    if (!value || value.startsWith("data:") || value.startsWith("blob:")) continue;
    let resolved: string;
    try {
      resolved = new URL(value, baseUrl).toString();
    } catch {
      continue;
    }
    if (!resolved.startsWith("http:") && !resolved.startsWith("https:")) continue;
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

// --- downloadAssets ---------------------------------------------------------

const DOWNLOAD_CONCURRENCY = 6;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_BUDGET_BYTES = 500 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const DOWNLOAD_RETRY_ATTEMPTS = 2; // + the initial try = 3 total
const RETRY_BASE_DELAY_MS = 300;

const EXT_FROM_CONTENT_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/avif": "avif",
  "font/woff": "woff",
  "font/woff2": "woff2",
  "font/ttf": "ttf",
  "font/otf": "otf",
  "application/font-woff": "woff",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
};

function extFromContentType(contentType: string | undefined): string | undefined {
  const base = contentType?.split(";")[0]?.trim().toLowerCase();
  return base ? EXT_FROM_CONTENT_TYPE[base] : undefined;
}

function extFromUrl(url: string): string | undefined {
  try {
    const match = /\.([a-z0-9]{1,8})$/i.exec(new URL(url).pathname);
    return match?.[1]?.toLowerCase();
  } catch {
    return undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(context: BrowserContext, url: string): Promise<APIResponse> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= DOWNLOAD_RETRY_ATTEMPTS; attempt++) {
    try {
      const res = await context.request.get(url, { timeout: DOWNLOAD_TIMEOUT_MS });
      if (res.ok() || res.status() < 500) return res; // only 5xx/network errors are retried
      lastErr = new Error(`HTTP ${res.status()}`);
    } catch (err) {
      lastErr = err;
    }
    if (attempt < DOWNLOAD_RETRY_ATTEMPTS) await delay(RETRY_BASE_DELAY_MS * 2 ** attempt);
  }
  throw lastErr;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export type DownloadResult = {
  assets: Map<string, string>;
  skipped: { url: string; code: string; reason: string }[];
  bytes: number;
};

// Downloads `urls` through the browser's request context (keeps cookies),
// bounded 6-way concurrency. Content is deduped by sha256 — identical bytes
// from different URLs land in one file (`assets/<sha>.<ext>`, relative to the
// workspace dir `destDir` is inside). Per-file cap 25MB, project-wide budget
// (default 500MB); either limit skips the offending URL(s) with a code/reason
// instead of throwing, so one bad asset never aborts the rest.
export async function downloadAssets(
  context: BrowserContext,
  urls: string[],
  destDir: string,
  opts?: { budgetBytes?: number },
): Promise<DownloadResult> {
  const budgetBytes = opts?.budgetBytes ?? DEFAULT_BUDGET_BYTES;
  await mkdir(destDir, { recursive: true });

  const assets = new Map<string, string>();
  const skipped: DownloadResult["skipped"] = [];
  const inFlightWrites = new Map<string, Promise<void>>();
  let bytes = 0;
  let budgetExceeded = false;

  // Reserves budget and writes tmp->rename exactly once per sha+ext, even
  // when several URLs share content: later callers for the same fileName
  // await this same promise instead of racing a duplicate write.
  async function writeIfNew(fileName: string, body: Buffer): Promise<void> {
    const absPath = join(destDir, fileName);
    if (await fileExists(absPath)) return; // already on disk (this run or a prior one): 0 new bytes
    // ponytail: budget check+reserve isn't cross-worker-atomic (a small race
    // window can overshoot by up to `DOWNLOAD_CONCURRENCY * MAX_FILE_BYTES`
    // under concurrent large downloads); add a real lock if the 500MB budget
    // must be exact rather than a soft cap.
    if (bytes + body.byteLength > budgetBytes) {
      budgetExceeded = true;
      throw new AppError(Codes.PROJECT_SIZE_LIMIT, `project asset budget of ${budgetBytes} bytes exceeded`, {
        fileName,
        size: body.byteLength,
        bytesSoFar: bytes,
      });
    }
    bytes += body.byteLength;
    const tmpPath = join(destDir, `${fileName}.tmp-${randomBytes(6).toString("hex")}`);
    await writeFile(tmpPath, body);
    await rename(tmpPath, absPath);
  }

  await mapLimit(urls, DOWNLOAD_CONCURRENCY, async (url) => {
    if (budgetExceeded) {
      skipped.push({ url, code: Codes.PROJECT_SIZE_LIMIT, reason: `project asset budget of ${budgetBytes} bytes already exceeded` });
      return;
    }

    let res: APIResponse;
    try {
      res = await fetchWithRetry(context, url);
    } catch (err) {
      skipped.push({ url, code: "DOWNLOAD_FAILED", reason: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (!res.ok()) {
      skipped.push({ url, code: "DOWNLOAD_FAILED", reason: `HTTP ${res.status()}` });
      return;
    }

    const contentLength = Number(res.headers()["content-length"]);
    if (Number.isFinite(contentLength) && contentLength > MAX_FILE_BYTES) {
      skipped.push({ url, code: Codes.ASSET_TOO_LARGE, reason: `content-length ${contentLength} bytes exceeds ${MAX_FILE_BYTES}` });
      return;
    }

    const body = await res.body();
    if (body.byteLength > MAX_FILE_BYTES) {
      skipped.push({ url, code: Codes.ASSET_TOO_LARGE, reason: `${body.byteLength} bytes exceeds ${MAX_FILE_BYTES}` });
      return;
    }

    const sha = createHash("sha256").update(body).digest("hex");
    const ext = extFromContentType(res.headers()["content-type"]) ?? extFromUrl(url) ?? "bin";
    const fileName = `${sha}.${ext}`;

    let writePromise = inFlightWrites.get(fileName);
    if (!writePromise) {
      writePromise = writeIfNew(fileName, body);
      inFlightWrites.set(fileName, writePromise);
    }

    try {
      await writePromise;
      assets.set(url, `assets/${fileName}`);
    } catch (err) {
      if (err instanceof AppError) {
        skipped.push({ url, code: err.code, reason: err.message });
      } else {
        skipped.push({ url, code: "DOWNLOAD_FAILED", reason: err instanceof Error ? err.message : String(err) });
      }
    }
  });

  return { assets, skipped, bytes };
}
