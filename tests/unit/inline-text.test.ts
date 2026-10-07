import { expect, test } from "vitest";
import type { IRNodeV2 } from "@/core/ir-v2";
import { textBatch, type DomLike } from "@/app/p/[id]/editor/visual/inline-text";

const n = (id: string, tag: string, children: IRNodeV2[] = [], extra: Partial<IRNodeV2> = {}): IRNodeV2 =>
  ({ id, tag, type: tag === "#text" ? "text" : "container", attrs: {}, styles: { base: {}, bp: {}, state: {}, pseudo: {} }, children, ...extra });
const t = (text: string): DomLike => ({ nodeType: 3, nodeName: "#text", textContent: text, childNodes: [] });
const el = (name: string, children: DomLike[] = [], attrs: Record<string, string> = {}): DomLike =>
  ({ nodeType: 1, nodeName: name.toUpperCase(), textContent: null, childNodes: children, getAttribute: (k) => attrs[k] ?? null });
// <h1>Xin <b>chào</b> bạn</h1>
const ir = () => n("h", "h1", [n("t1", "#text", [], { text: "Xin " }), n("b1", "b", [n("t2", "#text", [], { text: "chào" })]), n("t3", "#text", [], { text: " bạn" })]);

test("same inline structure: setText only for the texts that changed; unchanged -> no command", () => {
  expect(textBatch(ir(), el("h1", [t("Xin "), el("b", [t("chào")], { "data-ir-id": "b1" }), t(" bạn")]))).toEqual({ commands: [] });
  expect(textBatch(ir(), el("h1", [t("Chào "), el("b", [t("chào")], { "data-ir-id": "b1" }), t(" các bạn")]))).toEqual({ commands: [
    { op: "setText", id: "t1", text: "Chào " }, { op: "setText", id: "t3", text: " các bạn" },
  ] });
  // the browser split a text node: merged again before comparing
  expect(textBatch(ir(), el("h1", [t("Xin"), t(" "), el("b", [t("chào")], { "data-ir-id": "b1" }), t(" bạn")]))).toEqual({ commands: [] });
});

test("changed structure with text + b/i/a/br only: the children are replaced in one batch (strong->b, em->i, unknown tags unwrapped, unsafe href dropped)", () => {
  const out = textBatch(ir(), el("h1", [t("Xin chào "), el("strong", [t("bạn")]), el("br"), el("em", [el("span", [t("ơi")])]), el("a", [t("x")], { href: "javascript:alert(1)" }), el("a", [t("y")], { href: "/lien-he" })]));
  expect(out).toEqual({ commands: [
    { op: "deleteNode", id: "t1" }, { op: "deleteNode", id: "b1" }, { op: "deleteNode", id: "t3" },
    { op: "createNode", parentId: "h", index: 0, draft: { tag: "#text", text: "Xin chào " } },
    { op: "createNode", parentId: "h", index: 1, draft: { tag: "b", attrs: {}, children: [{ tag: "#text", text: "bạn" }] } },
    { op: "createNode", parentId: "h", index: 2, draft: { tag: "br", attrs: {}, children: [] } },
    { op: "createNode", parentId: "h", index: 3, draft: { tag: "i", attrs: {}, children: [{ tag: "#text", text: "ơi" }] } },
    { op: "createNode", parentId: "h", index: 4, draft: { tag: "a", attrs: {}, children: [{ tag: "#text", text: "x" }] } },
    { op: "createNode", parentId: "h", index: 5, draft: { tag: "a", attrs: { href: "/lien-he" }, children: [{ tag: "#text", text: "y" }] } },
  ] });
  // a kept <a> keeps the document's href (the canvas shows the emitter's rewritten one)
  const link = n("p", "p", [n("a1", "a", [n("at", "#text", [], { text: "Liên hệ" })], { attrs: { href: "https://x.test/contact" } })]);
  expect(textBatch(link, el("p", [t("Gọi "), el("a", [t("Liên hệ")], { "data-ir-id": "a1", href: "contact.html" })]))).toMatchObject({ commands: expect.arrayContaining([
    { op: "createNode", parentId: "p", index: 1, draft: { tag: "a", type: "container", attrs: { href: "https://x.test/contact" }, styles: link.children[0]!.styles, children: [{ tag: "#text", text: "Liên hệ" }] } },
  ]) });
});

test("refused: a styled span (kept element that is not b/i/a/br) whose structure changed, generated instance texts, a structure change inside an instance, more than 50 commands", () => {
  const styled = n("p", "p", [n("s1", "span", [n("st", "#text", [], { text: "Giá" })]), n("t9", "#text", [], { text: " tốt" })]);
  expect(textBatch(styled, el("p", [el("span", [t("Giá")], { "data-ir-id": "s1" })]))).toEqual({ error: expect.stringMatching(/Esc/) });
  expect(textBatch(styled, el("p", [el("span", [t("Giá mới")], { "data-ir-id": "s1" }), t(" tốt")]))).toEqual({ commands: [{ op: "setText", id: "st", text: "Giá mới" }] });
  const gen = n("instance:3:x:h", "h1", [n("instance:3:x:t", "#text", [], { text: "a" })]);
  expect(textBatch(gen, el("h1", [t("b")]))).toEqual({ error: expect.stringMatching(/instance/) });
  const inst = n("h", "h1", [n("t1", "#text", [], { text: "a" })], { component: { id: "c", role: "instance", sourceId: "m" } });
  expect(textBatch(inst, el("h1", [t("a"), el("b", [t("b")])]))).toEqual({ error: expect.stringMatching(/instance/) });
  const long = n("p", "p", Array.from({ length: 30 }, (_, i) => n(`k${i}`, "#text", [], { text: `${i}` })));
  expect(textBatch(long, el("p", Array.from({ length: 30 }, (_, i) => el("b", [t(`${i}`)]))))).toEqual({ error: expect.stringMatching(/50/) });
});

test("fix round 1: caps, kept-node fidelity, no-op merge, href allowlist, skipped tags, foreign ids", () => {
  // >50 changed texts in the setText path
  const many = n("p", "p", Array.from({ length: 60 }, (_, i) => n(`m${i}`, "b", [n(`mt${i}`, "#text", [], { text: "a" })])));
  expect(textBatch(many, el("p", Array.from({ length: 60 }, (_, i) => el("b", [t("z")], { "data-ir-id": `m${i}` }))))).toEqual({ error: expect.stringMatching(/50/) });
  // a styled CTA <a target rel> survives an Enter-inserted <br>
  const styles = { base: { color: "red" }, bp: {}, state: {}, pseudo: {} };
  const cta = n("p", "p", [n("c1", "a", [n("ct", "#text", [], { text: "Mua" })], { attrs: { href: "/buy", target: "_blank", rel: "noopener", "aria-label": "m" }, styles })]);
  const out = textBatch(cta, el("p", [el("a", [t("Mua")], { "data-ir-id": "c1" }), el("br")]));
  expect(out).toMatchObject({ commands: [{ op: "deleteNode", id: "c1" }, { op: "createNode", draft: { tag: "a", attrs: { href: "/buy", target: "_blank", rel: "noopener", "aria-label": "m" }, styles } }, { draft: { tag: "br" } }] });
  // kept node that is interactive / component / behavior -> refused
  for (const extra of [{ behavior: "x" }, { component: { id: "c", role: "main" as const } }, { interactive: {} as never }]) {
    const k = n("p", "p", [n("k1", "a", [n("kt", "#text", [], { text: "a" })], extra)]);
    expect(textBatch(k, el("p", [el("a", [t("a")], { "data-ir-id": "k1" }), el("br")]))).toEqual({ error: expect.stringMatching(/Esc/) });
  }
  // no-op: adjacent / empty IR text nodes
  const split = n("p", "p", [n("s1", "#text", [], { text: "ab" }), n("s2", "#text", [], { text: "" }), n("s3", "#text", [], { text: "cd" })]);
  expect(textBatch(split, el("p", [t("abcd")]))).toEqual({ commands: [] });
  // href allowlist
  const hrefs = (h: string) => textBatch(n("p", "p", []), el("p", [el("a", [t("x")], { href: h })]));
  for (const bad of [" JaVa\tScRiPt:alert(1)", "data:text/html,x", "vbscript:x", "ja\nvascript:x"]) expect(hrefs(bad)).toMatchObject({ commands: [{ draft: { attrs: {} } }] });
  for (const ok of ["https://a.test", "mailto:a@b.c", "tel:1", "#top", "//cdn.test/x", "page.html"]) expect(hrefs(ok)).toMatchObject({ commands: [{ draft: { attrs: { href: ok } } }] });
  // script/style/template skipped; foreign data-ir-id unwrapped, never invented
  expect(textBatch(n("p", "p", []), el("p", [t("a"), el("script", [t("evil()")]), el("style", [t("x{}")]), el("div", [t("b")], { "data-ir-id": "other" })]))).toEqual({ commands: [{ op: "createNode", parentId: "p", index: 0, draft: { tag: "#text", text: "ab" } }] });
  // empty result
  expect(textBatch(n("p", "p", [n("e1", "#text", [], { text: "a" })]), el("p", []))).toEqual({ commands: [{ op: "deleteNode", id: "e1" }] });
});
