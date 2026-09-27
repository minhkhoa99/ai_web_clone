// QA scorer (spec §9): per section x breakpoint pixel diff of the served clone against the capture shots.
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import type { Page } from "playwright";
import { evalWithTimeout, withPage, type BrowserHandle } from "./browser";
import { FONTS_READY_MS, lazyLoadScroll, type CaptureNode, type PageCapture } from "./capture";
import { fontsReadyInPage } from "./capture-eval";
import { pageFileNames } from "./emit-html";
import { writeFileAtomic } from "./fsx";
import type { IR, IRNode } from "./ir";
import { serveDir } from "./serve";
import { sameOrigin } from "./url";

export type Bbox = [number, number, number, number];
export type Bp = 375 | 768 | 1440;
export type SectionScore = {
  pageId: string;
  sectionId: string;
  bp: Bp;
  score: number;
  // null also when that crop has zero area (hardening spec §8: never written)
  heatPath: string | null; // null: the section resolves in no capture dom (nothing to diff)
  origPath: string | null; // null: same
  clonePath: string | null; // null: the clone has no element for this section
  bboxDelta: number; // max abs px delta of the clone bbox vs the original, hint only (0 when either side is missing)
};
export type ScoreOpts = {
  workspaceDir: string;
  outDir: string;
  ir: IR;
  captures: PageCapture[];
  bps?: Bp[];
  pageIds?: string[];
  sectionIds?: string[];
};

const BPS: Bp[] = [375, 768, 1440];
const VIEWPORT_HEIGHT = 900;
const FREEZE_CSS = "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}";
const DIFF_RGBA = [255, 0, 0, 255];

// Copies rect r of src (clamped to src bounds) into a new PNG.
function crop(src: PNG, [x, y, w, h]: Bbox): PNG {
  const x0 = Math.min(Math.max(0, Math.round(x)), src.width);
  const y0 = Math.min(Math.max(0, Math.round(y)), src.height);
  const width = Math.max(0, Math.min(Math.round(x + w), src.width) - x0);
  const height = Math.max(0, Math.min(Math.round(y + h), src.height) - y0);
  const out = new PNG({ width, height });
  if (width > 0 && height > 0) PNG.bitblt(src, out, x0, y0, width, height, 0, 0);
  return out;
}

// Pure. Canvas = max(w) x max(h); pixels outside the overlap of the two crops count as diff.
// Mask rects are crop-relative: those orig pixels are copied into the clone before diffing.
export function diffCrops(orig: PNG, clone: PNG, masks: Bbox[]): { score: number; heat: PNG; diffPixels: number; total: number } {
  const width = Math.max(orig.width, clone.width);
  const height = Math.max(orig.height, clone.height);
  const total = width * height;
  const heat = new PNG({ width, height });
  if (total === 0) return { score: 1, heat, diffPixels: 0, total };

  const overlap: Bbox = [0, 0, Math.min(orig.width, clone.width), Math.min(orig.height, clone.height)];
  const a = crop(orig, overlap);
  const b = crop(clone, overlap);
  for (const mask of masks) {
    const [mx, my] = mask.map(Math.round) as Bbox;
    const piece = crop(a, mask);
    if (piece.width > 0 && piece.height > 0) PNG.bitblt(piece, b, 0, 0, piece.width, piece.height, Math.max(0, mx), Math.max(0, my));
  }
  const overlapHeat = new PNG({ width: a.width, height: a.height });
  const inOverlap = a.width * a.height === 0 ? 0 : pixelmatch(a.data, b.data, overlapHeat.data, a.width, a.height, { threshold: 0.1, includeAA: false });

  for (let i = 0; i < total; i++) heat.data.set(DIFF_RGBA, i * 4);
  if (a.width > 0 && a.height > 0) PNG.bitblt(overlapHeat, heat, 0, 0, a.width, a.height, 0, 0);
  const diffPixels = inOverlap + total - a.width * a.height;
  return { score: 1 - diffPixels / total, heat, diffPixels, total };
}

// `<pageId>:0.i.j` tree path (0 = <html>) -> the node at that path in dom.
function nodeAtPath(dom: CaptureNode, id: string): CaptureNode | undefined {
  const [, ...steps] = id.slice(id.indexOf(":") + 1).split(".");
  let node: CaptureNode | undefined = dom;
  for (const step of steps) node = node?.children[Number(step)];
  return node;
}

// sectionId -> this page's own tree path for it: the placeholder's parent path + its index (the
// shell only drops <head>, a child of <html>, and sections sit under <body>). Shared layout
// sections carry the first page's ids, so their path on this page comes from here, not the root id.
function sectionPaths(shell: IRNode, out: Map<string, string> = new Map()): Map<string, string> {
  for (const [i, child] of shell.children.entries()) {
    if (child.tag === "#section") out.set(child.attrs["data-section"] ?? "", `${shell.id}.${i}`);
    else sectionPaths(child, out);
  }
  return out;
}

// Pure. sectionId -> capture node of that section at bp (1440 node when the path doesn't resolve at bp;
// undefined when it resolves in neither).
export function sectionNodes(capture: PageCapture, ir: IR, pageId: string, bp: Bp): Map<string, CaptureNode | undefined> {
  const page = ir.pages.find((p) => p.id === pageId);
  if (!page) throw new Error(`qa: unknown page ${pageId}`);
  const dom = (at: number) => capture.breakpoints.find((b) => b.bp === at)?.dom;
  const [dom1440, domBp] = [dom(1440), dom(bp)];
  const nodes = new Map<string, CaptureNode | undefined>();
  for (const [sectionId, path] of sectionPaths(page.shell)) {
    const wide = dom1440 && nodeAtPath(dom1440, path);
    const atBp = domBp && nodeAtPath(domBp, path);
    // The IR tree comes from the 1440 dom: a node at the same path with another tag is a different element.
    // ponytail: the 1440 fallback crops the wrong area of a 375/768 shot when the structure really differs
    // at that bp; per-bp section matching (by content hash) if that shows up on real sites.
    nodes.set(sectionId, atBp && (!wide || atBp.tag === wide.tag) ? atBp : wide);
  }
  return nodes;
}

export function sectionBoxes(capture: PageCapture, ir: IR, pageId: string, bp: Bp): Record<string, Bbox> {
  return Object.fromEntries([...sectionNodes(capture, ir, pageId, bp)].flatMap(([id, n]) => (n ? [[id, n.bbox]] : [])));
}

function dynamicBoxes(node: CaptureNode, out: Bbox[] = []): Bbox[] {
  if (node.attrs["data-dynamic"]) out.push(node.bbox);
  for (const child of node.children) dynamicBoxes(child, out);
  return out;
}

const writePng = (path: string, png: PNG) => writeFileAtomic(path, PNG.sync.write(png));

// Loads the clone at bp the way it is scored: lazy content scrolled in, animations frozen, fonts ready (10 s cap).
// Only the clone's own loopback server is reachable: QA never waits on (or depends on) the live site.
export async function prepareClonePage(page: Page, url: string, bp: Bp): Promise<void> {
  await page.route("**/*", (r) => (sameOrigin(r.request().url(), url) ? r.fallback() : r.abort()));
  await page.setViewportSize({ width: bp, height: VIEWPORT_HEIGHT });
  await page.goto(url, { waitUntil: "load" });
  await lazyLoadScroll(page); // same pass as capture, so lazy content is loaded like in the original shot
  await page.addStyleTag({ content: FREEZE_CSS });
  await evalWithTimeout(page, "Fonts ready", fontsReadyInPage, FONTS_READY_MS);
}

// Full-page screenshot of the clone at bp with animations frozen, plus each root's document bbox.
async function shootClone(handle: BrowserHandle, url: string, bp: Bp, rootIds: string[]): Promise<{ shot: PNG; boxes: (Bbox | null)[] }> {
  return withPage(handle, async (page) => {
    await prepareClonePage(page, url, bp);
    const shot = PNG.sync.read(await page.screenshot({ fullPage: true, animations: "disabled", caret: "hide" }));
    const boxes = await evalWithTimeout(page, "Section boxes", (ids) =>
      ids.map((id): [number, number, number, number] | null => {
        const el = document.querySelector(`[data-ir-id="${CSS.escape(id)}"]`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return [r.x + window.scrollX, r.y + window.scrollY, r.width, r.height];
      }),
      rootIds,
    );
    return { shot, boxes };
  });
}

// Pages and bps run sequentially (one browser page at a time); results are relative to workspaceDir.
export async function scoreSections(handle: BrowserHandle, opts: ScoreOpts): Promise<SectionScore[]> {
  const { workspaceDir, ir } = opts;
  const files = pageFileNames(ir.pages);
  const sections = new Map(ir.sections.map((s) => [s.id, s]));
  const server = await serveDir(opts.outDir);
  const results: SectionScore[] = [];
  try {
    for (const capture of opts.captures) {
      const { pageId } = capture;
      if (opts.pageIds && !opts.pageIds.includes(pageId)) continue;
      const file = files.get(pageId);
      if (!file) throw new Error(`qa: page ${pageId} is not in the IR`);
      for (const bp of opts.bps ?? BPS) {
        const nodes = [...sectionNodes(capture, ir, pageId, bp)].filter(([id]) => !opts.sectionIds || opts.sectionIds.includes(id));
        if (nodes.length === 0) continue;
        const rootIds = nodes.map(([id]) => sections.get(id)!.root.id);
        const [orig, clone] = await Promise.all([
          readFile(join(workspaceDir, "pages", pageId, "shots", `${bp}.png`)).then((buf) => PNG.sync.read(buf)),
          shootClone(handle, `${server.url}/${file}`, bp, rootIds),
        ]);
        for (const [i, [sectionId, node]] of nodes.entries()) {
          const cloneBox = clone.boxes[i] ?? null;
          const rel = posix.join("qa", pageId, sectionId);
          const origCrop = node && crop(orig, node.bbox);
          const cloneCrop = cloneBox && crop(clone.shot, cloneBox);
          const masks = node ? dynamicBoxes(node).map(([x, y, w, h]): Bbox => [x - node.bbox[0], y - node.bbox[1], w, h]) : [];
          const diff = origCrop && cloneCrop ? diffCrops(origCrop, cloneCrop, masks) : { score: 0, heat: origCrop };
          // A zero-area crop is scored as usual but never written (hardening spec §8: an encoded 0-height PNG
          // does not read back): its path is null.
          const [origPng, heatPng, clonePng] = [origCrop, diff.heat, cloneCrop].map((png) => (png && png.width > 0 && png.height > 0 ? png : null));
          const paths = {
            origPath: origPng ? `${rel}/${bp}-orig.png` : null,
            heatPath: heatPng ? `${rel}/${bp}-heat.png` : null,
            clonePath: clonePng ? `${rel}/${bp}-clone.png` : null,
          };
          await Promise.all([
            origPng && writePng(join(/*turbopackIgnore: true*/ workspaceDir, paths.origPath!), origPng),
            heatPng && writePng(join(/*turbopackIgnore: true*/ workspaceDir, paths.heatPath!), heatPng),
            clonePng && writePng(join(/*turbopackIgnore: true*/ workspaceDir, paths.clonePath!), clonePng),
          ]);
          const bboxDelta = node && cloneBox ? Math.max(...node.bbox.map((v, k) => Math.abs(v - cloneBox[k]!))) : 0;
          results.push({ pageId, sectionId, bp, score: diff.score, ...paths, bboxDelta });
        }
      }
    }
  } finally {
    await server.close();
  }
  return results;
}
