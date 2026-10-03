// E2 §12 end to end on site4: capture -> IR kinds / config / confidence, the runtime on the emitted clone, behaviour QA
// lifting the Fidelity items. The editor half of §12 (add / duplicate / delete / reorder, Undo/Redo, reload, 409) and
// parity live in editor-components.test.ts; the pixel baseline of site1-3 in qa-baseline.test.ts.
import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openBrowser, withPage, type BrowserHandle } from "@/core/browser";
import { capturePage, type PageCapture } from "@/core/capture";
import { emitHtml } from "@/core/emit-html";
import { withBehavior } from "@/core/fidelity";
import { buildIR } from "@/core/ir";
import { rolesOf, type CarouselSpec, type ModalSpec } from "@/core/interactive";
import type { IRNodeV2, IRV2 } from "@/core/ir-v2";
import { checkBehavior } from "@/core/qa-behavior";
import { serveDir } from "@/core/serve";

let handle: BrowserHandle;
let tmp = "";
let ir: IRV2;
let outDir = "";
const servers: { close(): Promise<void> }[] = [];
// every node of the page: sections and the shell (site4's <footer> holds only the hidden dialog: no section, it stays in the shell)
const all = (doc: IRV2): IRNodeV2[] => { const out: IRNodeV2[] = []; const v = (n: IRNodeV2) => { out.push(n); n.children.forEach(v); }; doc.pages.forEach((p) => v(p.shell)); doc.sections.forEach((s) => v(s.root)); return out; };
const pathTo = (root: IRNodeV2, id: string): IRNodeV2[] | undefined => { if (root.id === id) return [root]; for (const c of root.children) { const p = pathTo(c, id); if (p) return [root, ...p]; } return undefined; };
const byAttr = (doc: IRV2, name: string, value: string) => all(doc).find((n) => n.attrs[name] === value);

beforeAll(async () => {
  handle = await openBrowser({ headed: false });
  // the allowlisted embed is answered locally: no network outside the fixture
  await handle.context.route("https://www.youtube.com/**", (r) => r.fulfill({ contentType: "text/html", body: "<html></html>" }));
  await handle.context.route("https://www.youtube-nocookie.com/**", (r) => r.fulfill({ contentType: "text/html", body: "<html></html>" }));
  tmp = await mkdtemp(join(tmpdir(), "site4-"));
  const site = await serveDir(fileURLToPath(new URL("../fixtures/site4", import.meta.url)));
  servers.push(site);
  const workspaceDir = join(tmp, "ws"), url = `${site.url}/index.html`;
  const meta = await capturePage(handle, { url, pageId: "home", workspaceDir });
  const cap = JSON.parse(await readFile(join(workspaceDir, meta.capturePath), "utf8")) as PageCapture;
  ir = buildIR([cap]);
  outDir = join(tmp, "out");
  await emitHtml(ir, { outDir, workspaceDir, assetMap: cap.assets, pageUrls: { home: url } });
}, 180_000);
afterAll(async () => { await handle?.close(); for (const s of servers) await s.close(); if (tmp) await rm(tmp, { recursive: true, force: true }); });

test("site4 clones to the right kinds and confidences", () => {
  // the component whose root, or one of whose parts, is the element with that html id
  const spec = (htmlId: string) => {
    const node = byAttr(ir, "id", htmlId)!;
    return all(ir).find((n) => n.interactive && (n.id === node.id || rolesOf(n.interactive).some(([ref]) => ref === node.id)))?.interactive;
  };
  expect(spec("swiper-a")).toMatchObject({ kind: "carousel", source: "swiper", confidence: "config", loop: true, autoplay: true, interval: 3000, slidesPerView: { "1440": 3, "768": 2, "375": 1 } });
  expect((spec("swiper-a") as CarouselSpec).slides).toHaveLength(4); // duplicates excluded
  expect(spec("swiper-hidden")).toMatchObject({ kind: "carousel", confidence: "observed", autoplay: true });
  expect(spec("slick-a")).toMatchObject({ kind: "carousel", source: "slick", confidence: "config" });
  expect(spec("snap")).toMatchObject({ kind: "carousel", source: "scroll-snap", confidence: "observed" });
  const kinds = all(ir).flatMap((n) => (n.interactive ? [n.interactive.kind] : []));
  for (const kind of ["tabs", "accordion", "modal", "menu", "video"]) expect(kinds).toContain(kind);
  expect(all(ir).find((n) => n.interactive?.kind === "menu")!.interactive).toMatchObject({ openOn: "hover" });
  expect(all(ir).filter((n) => n.interactive?.kind === "video").map((n) => (n.interactive as { mode: string }).mode).sort()).toEqual(["embed", "native"]);
});

test("Review Focus 5: the modal trigger in <header> (a section) and its dialog in <footer> (the shell) are one component", () => {
  const trigger = byAttr(ir, "id", "open-dlg")!, dialog = byAttr(ir, "id", "dlg")!;
  const modal = all(ir).find((n) => n.interactive?.kind === "modal")!.interactive as ModalSpec;
  expect(modal).toMatchObject({ dialog: dialog.id, triggers: [trigger.id] });
  expect(modal.closeOn).toContain("esc");
  // a fresh clone: the captured SP1 modal interaction is this clone's detection, not a v1 migration
  const notes = ir.fidelity.filter((x) => x.nodeId === dialog.id && x.feature === "component-note").map((x) => x.note);
  expect(notes.length).toBeGreaterThan(0);
  expect(notes.every((note) => note.startsWith("Nhận diện khi clone"))).toBe(true);
  const header = ir.sections.find((s) => pathTo(s.root, trigger.id))!;
  expect(header.root.tag).toBe("header");
  expect(pathTo(header.root, dialog.id)).toBeUndefined(); // the dialog is outside the trigger's subtree
  expect(pathTo(ir.pages[0]!.shell, dialog.id)!.map((n) => n.tag)).toContain("footer");
});

test("on the clone: next changes slide, autoplay changes slide, Esc closes the modal and returns focus, hover opens the menu, a tab switches", { timeout: 60_000 }, async () => {
  const server = await serveDir(outDir);
  servers.push(server);
  await withPage(handle, async (page) => {
    await page.clock.install();
    await page.goto(`${server.url}/index.html`);
    const swiper = page.locator('[data-c="carousel"]').first();
    const start = await swiper.getAttribute("data-c-active");
    await swiper.locator('[data-c-role~="next"]').click();
    expect(await swiper.getAttribute("data-c-active")).not.toBe(start);
    const auto = await swiper.getAttribute("data-c-active");
    await page.mouse.move(0, 0); // hover / focus-within pause autoplay
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.clock.runFor(4500);
    expect(await swiper.getAttribute("data-c-active")).not.toBe(auto);
    await page.click("#open-dlg");
    expect(await page.isVisible("#dlg")).toBe(true);
    expect(await page.evaluate(() => document.getElementById("dlg")!.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape");
    expect(await page.isVisible("#dlg")).toBe(false);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("open-dlg");
    await page.hover('a[aria-haspopup="true"]'); // the emitted page keeps html ids and aria, not the site's classes
    expect(await page.isVisible('[data-c="menu"] [data-c-role="panel"]')).toBe(true);
    await page.click('[role="tab"]:nth-of-type(2)');
    expect(await page.isVisible("#tp2")).toBe(true);
  });
});

test("behaviour QA passes for every site4 component and lifts its Fidelity item", { timeout: 120_000 }, async () => {
  const results = await checkBehavior(handle, { outDir, ir });
  expect(results.filter((r) => !r.ok)).toEqual([]);
  const lifted = withBehavior(ir.fidelity, results).filter((x) => x.feature === "component");
  expect(lifted.length).toBeGreaterThanOrEqual(9);
  expect(lifted.every((x) => x.status === "supported" || x.note.includes("đã kiểm chứng"))).toBe(true);
  // §4: the embed is checked (its iframe is on the allowlist) but its item stays partial
  const embed = results.find((r) => r.kind === "video" && r.embed)!;
  expect(embed.ok).toBe(true);
  expect(lifted.find((x) => x.nodeId === embed.nodeId)!.status).toBe("partial");
});
