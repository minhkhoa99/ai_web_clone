import type { CaptureNode } from "./capture";

export type SnapshotResult = { root: CaptureNode } | { limitExceeded: true };

// Runs inside the page via page.evaluate: must stay self-contained (no imports
// at runtime, no outer references). `any` is used for DOM nodes that may come
// from other documents (same-origin iframes), where instanceof checks fail.
export function snapshotInPage(maxNodes: number): SnapshotResult {
  const SKIP_TAGS = new Set(["script", "noscript", "template", "style"]);
  const EMPTY_PSEUDO = new Set(["none", "normal"]);
  const round = (n: number) => Math.round(n * 100) / 100;

  // Clean same-origin document to read per-tag default styles from.
  const sandbox = document.createElement("iframe");
  sandbox.setAttribute("style", "position:fixed;left:0;top:0;width:0;height:0;border:0;visibility:hidden");
  document.documentElement.appendChild(sandbox);
  const sandboxDoc = sandbox.contentDocument!;
  sandboxDoc.open();
  sandboxDoc.write("<!DOCTYPE html><html><head></head><body></body></html>");
  sandboxDoc.close();
  const sandboxWin = sandboxDoc.defaultView!;

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

  let count = 0;
  let limitExceeded = false;

  // ponytail: recursive walk; a pathologically deep DOM (~10k levels) could overflow the stack, go iterative if seen.
  // offset = document-coordinate origin of the node's viewport (scroll + iframe position).
  const visit = (node: any, offset: [number, number], inHead: boolean): CaptureNode | null => {
    if (limitExceeded) return null;
    if (node.nodeType === 3) {
      if (!node.data.trim()) return null;
      if (++count > maxNodes) return (limitExceeded = true), null;
      const range = node.ownerDocument.createRange();
      range.selectNodeContents(node);
      return { tag: "#text", text: node.data, attrs: {}, bbox: bboxOf(range.getBoundingClientRect(), offset), style: {}, children: [] };
    }
    if (node.nodeType !== 1 || node === sandbox) return null;
    const tag: string = node.localName;
    if (SKIP_TAGS.has(tag) || (tag === "link" && /\bstylesheet\b/i.test(node.getAttribute("rel") ?? ""))) return null;
    if (++count > maxNodes) return (limitExceeded = true), null;

    const attrs: Record<string, string> = {};
    for (const attr of node.attributes) {
      if (attr.name !== "style" && !attr.name.startsWith("on")) attrs[attr.name] = attr.value;
    }
    const rect: DOMRect = node.getBoundingClientRect();
    const result: CaptureNode = { tag, attrs, bbox: bboxOf(rect, offset), style: {}, children: [] };
    const childInHead = inHead || tag === "head";

    const frameDoc = tag === "iframe" ? node.contentDocument : null; // null when cross-origin
    if (frameDoc?.documentElement) {
      // Frame rects are relative to the frame viewport, which sits at the iframe's inner box.
      const frameOffset: [number, number] = [rect.left + node.clientLeft + offset[0], rect.top + node.clientTop + offset[1]];
      const child = visit(frameDoc.documentElement, frameOffset, false);
      if (child) result.children.push(child);
    } else {
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
    const root = visit(document.documentElement, [window.scrollX, window.scrollY], false);
    return limitExceeded ? { limitExceeded: true } : { root: root! };
  } finally {
    sandbox.remove();
  }
}
