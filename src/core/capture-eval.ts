import type { CaptureNode } from "./capture";

export type SnapshotResult = { root: CaptureNode } | { limitExceeded: true };

// Runs inside the page via page.evaluate: must stay self-contained (no imports
// at runtime, no outer references). `any` is used for DOM nodes that may come
// from other documents (same-origin iframes), where instanceof checks fail.
export function snapshotInPage(maxNodes: number): SnapshotResult {
  const SKIP_TAGS = new Set(["script", "noscript", "template", "style"]);
  const EMPTY_PSEUDO = new Set(["none", "normal"]);
  const PRESERVE_WS = new Set(["pre", "pre-wrap", "pre-line", "break-spaces"]);
  const round = (n: number) => Math.round(n * 100) / 100;

  // Clean same-origin document to read per-tag default styles from.
  const sandbox = document.createElement("iframe");
  sandbox.setAttribute("style", "position:fixed;left:0;top:0;width:0;height:0;border:0;visibility:hidden");
  document.documentElement.appendChild(sandbox);
  // Assigned inside the try below so `finally` always removes the sandbox.
  let sandboxDoc: Document;
  let sandboxWin: Window;

  const toRecord = (cs: CSSStyleDeclaration) => {
    const out: Record<string, string> = {};
    for (let i = 0; i < cs.length; i++) {
      const prop = cs[i]!;
      if (!prop.startsWith("--")) out[prop] = cs.getPropertyValue(prop);
    }
    return out;
  };

  const defaults = new Map<string, { el: Record<string, string>; before: Record<string, string>; after: Record<string, string> }>();
  const defaultsFor = (el: any) => {
    const key = `${el.namespaceURI} ${el.localName}`;
    const cached = defaults.get(key);
    if (cached) return cached;
    const isRoot = el.localName === "html" || el.localName === "body";
    const probe = isRoot
      ? el.localName === "html" ? sandboxDoc.documentElement : sandboxDoc.body
      : sandboxDoc.body.appendChild(sandboxDoc.createElementNS(el.namespaceURI, el.localName));
    const entry = {
      el: toRecord(sandboxWin.getComputedStyle(probe)),
      before: toRecord(sandboxWin.getComputedStyle(probe, "::before")),
      after: toRecord(sandboxWin.getComputedStyle(probe, "::after")),
    };
    if (!isRoot) probe.remove();
    defaults.set(key, entry);
    return entry;
  };

  const diff = (cs: CSSStyleDeclaration, base: Record<string, string>) => {
    const out: Record<string, string> = {};
    for (let i = 0; i < cs.length; i++) {
      const prop = cs[i]!;
      if (prop.startsWith("--")) continue;
      const value = cs.getPropertyValue(prop);
      if (base[prop] !== value) out[prop] = value;
    }
    return out;
  };

  const bboxOf = (rect: DOMRect, offset: [number, number]): [number, number, number, number] => [
    round(rect.left + offset[0]),
    round(rect.top + offset[1]),
    round(rect.width),
    round(rect.height),
  ];

  // Computed width/height are always used px; emitting them as fixed sizes breaks margin
  // collapse and reflow. Drop them where `auto` yields the same box (probed via inline
  // !important, then the style attribute is restored exactly so the page is unchanged).
  const XHTML = "http://www.w3.org/1999/xhtml";
  const REPLACED = new Set(["img", "video", "canvas", "iframe", "svg", "input", "select", "textarea", "object", "embed"]);
  const BLOCK_LEVEL = new Set(["block", "flex", "grid", "list-item", "table", "flow-root"]);
  const SIZE_TOLERANCE = 0.5;
  // Height probe also sets align-self:flex-start: otherwise a flex/grid parent stretches the item to its
  // siblings' height, every equal-height item looks auto and dropping them all collapses the row. Works for
  // any layout parent (incl. through display:contents); a no-op for non-flex/grid items.
  const sameWithAuto = (el: any, prop: "height" | "width"): boolean => {
    const original: string | null = el.getAttribute("style");
    const before: number = el.getBoundingClientRect()[prop];
    el.style.setProperty(prop, "auto", "important");
    if (prop === "height") el.style.setProperty("align-self", "flex-start", "important");
    const after: number = el.getBoundingClientRect()[prop];
    if (original === null) el.removeAttribute("style");
    else el.setAttribute("style", original);
    return Math.abs(before - after) <= SIZE_TOLERANCE;
  };
  const dropAutoSize = (el: any, cs: CSSStyleDeclaration, style: Record<string, string>) => {
    if (el.namespaceURI !== XHTML || REPLACED.has(el.localName)) return;
    if ((style.height || style["block-size"]) && sameWithAuto(el, "height")) {
      delete style.height;
      delete style["block-size"];
    }
    if ((style.width || style["inline-size"]) && BLOCK_LEVEL.has(cs.display) && sameWithAuto(el, "width")) {
      delete style.width;
      delete style["inline-size"];
    }
  };

  let count = 0;
  let limitExceeded = false;

  // ponytail: recursive walk; a pathologically deep DOM (~10k levels) could overflow the stack, go iterative if seen.
  // offset = document-coordinate origin of the node's viewport (scroll + iframe position).
  const visit = (node: any, offset: [number, number], inHead: boolean): CaptureNode | null => {
    if (limitExceeded) return null;
    if (node.nodeType === 3) {
      // Whitespace-only text is layout (gaps between inline siblings): kept as one space,
      // verbatim under preserving white-space. Head whitespace carries nothing.
      let text: string = node.data;
      if (!text.trim()) {
        if (inHead) return null;
        const parent = node.parentElement ?? node.parentNode?.host;
        const ws = parent ? node.ownerDocument.defaultView.getComputedStyle(parent).whiteSpace : "normal";
        if (!PRESERVE_WS.has(ws)) text = " ";
      }
      if (++count > maxNodes) return (limitExceeded = true), null;
      const range = node.ownerDocument.createRange();
      range.selectNodeContents(node);
      return { tag: "#text", text, attrs: {}, bbox: bboxOf(range.getBoundingClientRect(), offset), style: {}, children: [] };
    }
    if (node.nodeType !== 1 || node === sandbox) return null;
    const tag: string = node.localName;
    if (SKIP_TAGS.has(tag) || (tag === "link" && /\bstylesheet\b/i.test(node.getAttribute("rel") ?? ""))) return null;
    if (++count > maxNodes) return (limitExceeded = true), null;

    const attrs: Record<string, string> = {};
    for (const attr of node.attributes) {
      if (attr.name !== "style" && !attr.name.startsWith("on")) attrs[attr.name] = attr.value;
    }
    if (tag === "canvas") attrs["data-dynamic"] = "canvas"; // pixel content isn't in the DOM snapshot; capturePage screenshots it separately
    const rect: DOMRect = node.getBoundingClientRect();
    const result: CaptureNode = { tag, attrs, bbox: bboxOf(rect, offset), style: {}, children: [] };
    const childInHead = inHead || tag === "head";

    const frameDoc = tag === "iframe" ? node.contentDocument : null; // null when cross-origin
    if (frameDoc?.documentElement) {
      // Frame rects are relative to the frame viewport, which sits at the iframe's inner box.
      const frameOffset: [number, number] = [rect.left + node.clientLeft + offset[0], rect.top + node.clientTop + offset[1]];
      const child = visit(frameDoc.documentElement, frameOffset, false);
      if (child) result.children.push(child);
    } else if (tag !== "iframe") {
      // Cross-origin iframes keep tag + attrs only (fallback content skipped).
      // Open shadow root content first, then light children.
      const sources: any[] = node.shadowRoot ? [...node.shadowRoot.childNodes, ...node.childNodes] : [...node.childNodes];
      for (const source of sources) {
        const child = visit(source, offset, childInHead);
        if (child) result.children.push(child);
      }
    }
    if (childInHead) return result;

    const win = node.ownerDocument.defaultView;
    const cs: CSSStyleDeclaration = win.getComputedStyle(node);
    const base = defaultsFor(node);
    result.style = diff(cs, base.el);
    if (cs.display !== "none") dropAutoSize(node, cs, result.style);
    const before: CSSStyleDeclaration = win.getComputedStyle(node, "::before");
    const after: CSSStyleDeclaration = win.getComputedStyle(node, "::after");
    const pseudo: NonNullable<CaptureNode["pseudo"]> = {};
    if (!EMPTY_PSEUDO.has(before.content)) pseudo.before = diff(before, base.before);
    if (!EMPTY_PSEUDO.has(after.content)) pseudo.after = diff(after, base.after);
    if (pseudo.before || pseudo.after) result.pseudo = pseudo;

    const zeroSize = rect.width === 0 && rect.height === 0;
    const hasVisibleChild = result.children.some((c) => !c.hidden && (c.tag !== "#text" || c.bbox[2] > 0 || c.bbox[3] > 0));
    if (cs.display === "none" || cs.visibility === "hidden" || (zeroSize && !hasVisibleChild)) result.hidden = true;
    return result;
  };

  try {
    sandboxDoc = sandbox.contentDocument!;
    try {
      sandboxDoc.write("<!DOCTYPE html><html><head></head><body></body></html>");
      sandboxDoc.close();
    } catch {
      // Trusted Types forbids write(): keep the initial about:blank document (quirks mode, near-identical UA defaults).
    }
    sandboxWin = sandboxDoc.defaultView!;
    const root = visit(document.documentElement, [window.scrollX, window.scrollY], false);
    return limitExceeded ? { limitExceeded: true } : { root: root! };
  } finally {
    sandbox.remove();
  }
}

// Runs inside the page via page.evaluate: scrolls to the bottom in bounded
// steps (letting lazy-load observers fire), decodes every <img> with a
// per-image timeout so a broken image can't hang the pass, then scrolls back
// to the top. `truncated` is true only when the step/px cap was hit before
// the page actually reached its bottom (i.e. infinite scroll).
export async function lazyLoadInPage(opts: {
  maxSteps: number;
  maxPx: number;
  stepDelayMs: number;
  decodeTimeoutMs: number;
}): Promise<{ truncated: boolean }> {
  const { maxSteps, maxPx, stepDelayMs, decodeTimeoutMs } = opts;
  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const viewportH = window.innerHeight;

  let steps = 0;
  let scrolledPx = 0;
  let reachedBottom = viewportH >= document.documentElement.scrollHeight;

  while (!reachedBottom && steps < maxSteps && scrolledPx < maxPx) {
    window.scrollBy(0, viewportH);
    await delay(stepDelayMs);
    steps++;
    scrolledPx += viewportH;
    reachedBottom = window.scrollY + viewportH >= document.documentElement.scrollHeight - 1;
  }

  await Promise.all(
    Array.from(document.images).map((img) => Promise.race([img.decode().catch(() => undefined), delay(decodeTimeoutMs)])),
  );
  window.scrollTo(0, 0);
  return { truncated: !reachedBottom };
}

export type CssomExtract = {
  keyframes: string[];
  fontFace: string[];
  media: string[];
  varNames: string[];
  stateSelectors: string[];
};

// Both eval entry points below inline their own copy of the rule walk and
// dedupe logic: page.evaluate serializes only the passed function's own
// source, so nothing at module scope (helper functions, regex constants) is
// visible to it at runtime.

// Runs inside the page: reads every same-origin document.styleSheets entry.
// Sheets that throw on .cssRules (cross-origin, no CORS) are reported by
// href instead so the caller can fetch + parse them in a follow-up pass.
export function readCssomInPage(): CssomExtract & { crossOriginHrefs: string[] } {
  const out: CssomExtract = { keyframes: [], fontFace: [], media: [], varNames: [], stateSelectors: [] };
  const statePseudo = /:hover|:focus-visible|:focus|:active/;

  // Identical to the `walk` closure in parseCssTextInPage below — see the
  // file-level note above for why it's copy-pasted rather than shared.
  const walk = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSMediaRule) {
        out.media.push(rule.cssText);
        walk(rule.cssRules);
      } else if (rule instanceof CSSSupportsRule) {
        walk(rule.cssRules);
      } else if (rule instanceof CSSKeyframesRule) {
        out.keyframes.push(rule.cssText);
      } else if (rule instanceof CSSFontFaceRule) {
        out.fontFace.push(rule.cssText);
      } else if (rule instanceof CSSStyleRule) {
        for (let i = 0; i < rule.style.length; i++) {
          const prop = rule.style[i]!;
          if (prop.startsWith("--")) out.varNames.push(prop);
        }
        for (const part of rule.selectorText.split(",")) {
          const trimmed = part.trim();
          if (statePseudo.test(trimmed)) {
            const base = trimmed.replace(new RegExp(statePseudo, "g"), "").trim();
            if (base) out.stateSelectors.push(base);
          }
        }
      }
    }
  };

  const crossOriginHrefs: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      if (sheet.href) crossOriginHrefs.push(sheet.href);
      continue;
    }
    walk(rules);
  }
  return {
    keyframes: [...new Set(out.keyframes)],
    fontFace: [...new Set(out.fontFace)],
    media: [...new Set(out.media)],
    varNames: [...new Set(out.varNames)],
    stateSelectors: [...new Set(out.stateSelectors)],
    crossOriginHrefs: [...new Set(crossOriginHrefs)],
  };
}

// Runs inside the page: parses raw CSS text (fetched in Node for sheets that
// were cross-origin) via a constructable stylesheet, then extracts the same
// shape as readCssomInPage. Malformed text is skipped, not thrown.
export function parseCssTextInPage(cssTexts: string[]): CssomExtract {
  const out: CssomExtract = { keyframes: [], fontFace: [], media: [], varNames: [], stateSelectors: [] };
  const statePseudo = /:hover|:focus-visible|:focus|:active/;

  // Identical to the `walk` closure in readCssomInPage above — see the
  // file-level note above for why it's copy-pasted rather than shared.
  const walk = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSMediaRule) {
        out.media.push(rule.cssText);
        walk(rule.cssRules);
      } else if (rule instanceof CSSSupportsRule) {
        walk(rule.cssRules);
      } else if (rule instanceof CSSKeyframesRule) {
        out.keyframes.push(rule.cssText);
      } else if (rule instanceof CSSFontFaceRule) {
        out.fontFace.push(rule.cssText);
      } else if (rule instanceof CSSStyleRule) {
        for (let i = 0; i < rule.style.length; i++) {
          const prop = rule.style[i]!;
          if (prop.startsWith("--")) out.varNames.push(prop);
        }
        for (const part of rule.selectorText.split(",")) {
          const trimmed = part.trim();
          if (statePseudo.test(trimmed)) {
            const base = trimmed.replace(new RegExp(statePseudo, "g"), "").trim();
            if (base) out.stateSelectors.push(base);
          }
        }
      }
    }
  };

  for (const text of cssTexts) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(text);
      walk(sheet.cssRules);
    } catch {
      // malformed CSS text from a cross-origin fetch: skip it
    }
  }
  return {
    keyframes: [...new Set(out.keyframes)],
    fontFace: [...new Set(out.fontFace)],
    media: [...new Set(out.media)],
    varNames: [...new Set(out.varNames)],
    stateSelectors: [...new Set(out.stateSelectors)],
  };
}

// Runs inside the page: resolves each custom-property name against the
// document's own cascade (getComputedStyle on :root), skipping names that
// resolve empty. Cross-origin custom properties merged in by the caller are
// still looked up here — they only matter if they also apply to this document.
export function readCssomVarsInPage(names: string[]): Record<string, string> {
  const cs = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = cs.getPropertyValue(name).trim();
    if (value) out[name] = value;
  }
  return out;
}

// Runs inside the page via page.evaluate: document.fonts.ready, capped at `ms` (a font request that never
// answers must not hang capture or QA). false = the cap won.
export function fontsReadyInPage(ms: number): Promise<boolean> {
  return Promise.race([document.fonts.ready.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
}
