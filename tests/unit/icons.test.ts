import { expect, test } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FILE_OF, NAMES } from "../../scripts/gen-icons.mjs";
import { ICONS } from "@/app/_ui/icons.gen";
import { Icon } from "@/app/_ui/Icon";

test("icons.gen.ts holds exactly the spec §1.5 subset (96 names), each a non-empty SVG path", () => {
  expect(NAMES).toHaveLength(96);
  expect(new Set(NAMES).size).toBe(96);
  expect(Object.keys(ICONS).sort()).toEqual([...NAMES].sort());
  // Case-insensitive: some Material Symbols 0.47.5 files start with a relative "m" moveto,
  // equivalent to "M" at the start of a path since the current point begins at (0,0).
  for (const d of Object.values(ICONS)) expect(d).toMatch(/^[Mm]/);
  expect(Object.keys(FILE_OF).every((n) => NAMES.includes(n))).toBe(true);
});

test("Icon is decorative: aria-hidden, not focusable, currentColor, Material viewBox, sizes 16 by default", () => {
  const html = renderToStaticMarkup(h(Icon, { name: "history" }));
  expect(html).toContain('aria-hidden="true"');
  expect(html).toContain('focusable="false"');
  expect(html).toContain('fill="currentColor"');
  expect(html).toContain('viewBox="0 -960 960 960"');
  expect(html).toContain('width="16"');
  expect(renderToStaticMarkup(h(Icon, { name: "lock", size: 14, className: "x" }))).toContain('class="icon x"');
});
