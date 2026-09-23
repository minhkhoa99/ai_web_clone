import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { dedupeStyles, extractTokens, hash6, structuralHash, type StyledNode } from "@/core/dedupe";

function el(id: string, tag: string, opts: Partial<StyledNode> = {}): StyledNode {
  return {
    id,
    tag,
    attrs: opts.attrs ?? {},
    style: opts.style ?? { base: {} },
    children: opts.children ?? [],
  };
}

function text(id: string): StyledNode {
  return { id, tag: "#text", attrs: {}, style: { base: {} }, children: [] };
}

test("hash6 is the first 6 hex chars of sha256", () => {
  const expected = createHash("sha256").update("hello").digest("hex").slice(0, 6);
  expect(hash6("hello")).toBe(expected);
  expect(hash6("hello")).toHaveLength(6);
});

test("3 nodes with the same style get the same class, one class entry", () => {
  const style = { base: { color: "#111", "font-size": "16px" } };
  const roots = [
    el("a", "div", { style }),
    el("b", "div", { style: { base: { color: "#111", "font-size": "16px" } } }),
    el("c", "span", { style: { base: { "font-size": "16px", color: "#111" } } }),
  ];

  const { classMap, classes } = dedupeStyles(roots);

  const clsA = classMap.get("a");
  const clsB = classMap.get("b");
  const clsC = classMap.get("c");
  expect(clsA).toBeDefined();
  expect(clsA).toEqual(clsB);
  expect(clsA).toEqual(clsC);
  expect(Object.keys(classes)).toHaveLength(1);
  expect(classes[(clsA as string[])[0] as string]).toEqual({ base: { color: "#111", "font-size": "16px" } });
});

test("class name has no leading dot and matches s-<hash6> pattern", () => {
  const roots = [el("a", "div", { style: { base: { color: "red" } } })];
  const { classMap } = dedupeStyles(roots);
  const cls = classMap.get("a") as string[];
  expect(cls[0]).toMatch(/^s-[0-9a-f]{6}$/);
});

test("node with entirely empty style gets no class entry", () => {
  const roots = [el("a", "div", { style: { base: {} } })];
  const { classMap, classes } = dedupeStyles(roots);
  expect(classMap.has("a")).toBe(false);
  expect(Object.keys(classes)).toHaveLength(0);
});

test("#text node never gets a class entry", () => {
  const roots = [el("a", "div", { style: { base: {} }, children: [text("t1")] })];
  const { classMap } = dedupeStyles(roots);
  expect(classMap.has("t1")).toBe(false);
});

test("differing media override produces a different class", () => {
  const a = el("a", "div", { style: { base: { color: "red" }, media: { "768": { color: "blue" } } } });
  const b = el("b", "div", { style: { base: { color: "red" }, media: { "768": { color: "green" } } } });

  const { classMap } = dedupeStyles([a, b]);
  expect(classMap.get("a")).not.toEqual(classMap.get("b"));
});

test("pseudo (before/after) content is part of the dedupe key", () => {
  const a = el("a", "div", { style: { base: { color: "red" }, before: { content: "'*'" } } });
  const b = el("b", "div", { style: { base: { color: "red" } } });

  const { classMap, classes } = dedupeStyles([a, b]);
  expect(classMap.get("a")).not.toEqual(classMap.get("b"));
  expect(Object.keys(classes)).toHaveLength(2);
});

test("walks nested children of all roots", () => {
  const child = el("child", "span", { style: { base: { color: "red" } } });
  const root = el("root", "div", { style: { base: {} }, children: [child] });

  const { classMap } = dedupeStyles([root]);
  expect(classMap.has("child")).toBe(true);
});

test("structuralHash: two sections with the same tag/class structure but different text produce the same hash", () => {
  const sectionA = el("s1", "section", {
    attrs: { class: "hero" },
    children: [
      el("h1a", "h1", { attrs: { class: "title" }, children: [text("tA")] }),
      el("pa", "p", { children: [text("t2A")] }),
    ],
  });
  const sectionB = el("s2", "section", {
    attrs: { class: "hero" },
    children: [
      el("h1b", "h1", { attrs: { class: "title" }, children: [text("tB")] }),
      el("pb", "p", { children: [text("t2B")] }),
    ],
  });

  expect(structuralHash(sectionA)).toBe(structuralHash(sectionB));
});

test("structuralHash: different structure produces a different hash", () => {
  const sectionA = el("s1", "section", { attrs: { class: "hero" }, children: [el("h1", "h1")] });
  const sectionB = el("s2", "section", { attrs: { class: "hero" }, children: [el("h2", "h2")] });

  expect(structuralHash(sectionA)).not.toBe(structuralHash(sectionB));
});

test("structuralHash: class token order on the same node does not matter", () => {
  const a = el("a", "div", { attrs: { class: "foo bar" } });
  const b = el("b", "div", { attrs: { class: "bar foo" } });
  expect(structuralHash(a)).toBe(structuralHash(b));
});

test("extractTokens: value used >= minCount becomes a numbered token, keeping the exact string", () => {
  const roots = [
    el("a", "div", { style: { base: { color: "#123abc" } } }),
    el("b", "div", { style: { base: { color: "#123abc" } } }),
    el("c", "div", { style: { base: { color: "#123abc" } } }),
    el("d", "div", { style: { base: { color: "#654321" } } }),
    el("e", "div", { style: { base: { color: "#654321" } } }),
  ];

  const tokens = extractTokens(roots, 3);
  expect(tokens["--color-1"]).toBe("#123abc");
  expect(Object.values(tokens)).not.toContain("#654321");
});

test("extractTokens: categories map to distinct prefixes and skip-listed values are ignored", () => {
  const roots = [
    el("a", "div", {
      style: {
        base: {
          color: "#111",
          "background-color": "#111",
          "border-top-color": "#111",
          "font-family": "Inter",
          "font-size": "14px",
          "margin-top": "8px",
          gap: "8px",
          "border-top-left-radius": "4px",
          "box-shadow": "0 1px 2px #000",
          "outline-color": "0px",
        },
      },
    }),
    el("b", "div", {
      style: {
        base: {
          color: "#111",
          "background-color": "#111",
          "border-top-color": "#111",
          "font-family": "Inter",
          "font-size": "14px",
          "margin-top": "8px",
          gap: "8px",
          "border-top-left-radius": "4px",
          "box-shadow": "0 1px 2px #000",
        },
      },
    }),
    el("c", "div", {
      style: {
        base: {
          color: "#111",
          "background-color": "#111",
          "border-top-color": "#111",
          "font-family": "Inter",
          "font-size": "14px",
          "margin-top": "8px",
          gap: "8px",
          "border-top-left-radius": "4px",
          "box-shadow": "0 1px 2px #000",
        },
      },
    }),
  ];

  const tokens = extractTokens(roots, 3);
  expect(tokens["--color-1"]).toBe("#111");
  expect(tokens["--font-1"]).toBe("Inter");
  expect(tokens["--size-1"]).toBe("14px");
  expect(tokens["--space-1"]).toBe("8px");
  expect(tokens["--radius-1"]).toBe("4px");
  expect(tokens["--shadow-1"]).toBe("0 1px 2px #000");
  expect(Object.values(tokens)).not.toContain("0px");
});

test("extractTokens: below-threshold values produce no token", () => {
  const roots = [
    el("a", "div", { style: { base: { color: "#abcabc" } } }),
    el("b", "div", { style: { base: { color: "#abcabc" } } }),
  ];
  const tokens = extractTokens(roots, 3);
  expect(Object.keys(tokens)).toHaveLength(0);
});

test("dedupeStyles and extractTokens are deterministic across repeated calls", () => {
  const roots = [
    el("a", "div", { style: { base: { color: "#111" } } }),
    el("b", "div", { style: { base: { color: "#111" } } }),
    el("c", "div", { style: { base: { color: "#111" } } }),
  ];

  const first = dedupeStyles(roots);
  const second = dedupeStyles(roots);
  expect([...first.classMap.entries()]).toEqual([...second.classMap.entries()]);
  expect(first.classes).toEqual(second.classes);

  const tokensFirst = extractTokens(roots, 3);
  const tokensSecond = extractTokens(roots, 3);
  expect(tokensFirst).toEqual(tokensSecond);
});
