"use client";
// E3 §1 canvas: the server's canvas document in a sandboxed srcdoc frame (same origin: the parent reads its DOM and
// wires events; no script is injected). Clicks select instead of acting, links and forms never navigate (§8).
// Partial updates swap section roots by data-ir-id and the inline stylesheet; a missing root -> the caller reloads.
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import type { Affected } from "@/core/editor-canvas";

export type CanvasHandle = {
  doc(): Document | null;
  element(id: string): HTMLElement | null;
  replace(a: Affected, rootOf: (sectionId: string) => string | undefined): boolean;
  post(message: unknown): void;
  toDoc(clientX: number, clientY: number): { x: number; y: number }; // parent client px -> frame document px (÷ zoom)
  hit(x: number, y: number): string | null; // data-ir-id under a document point
};
type Props = {
  ref?: Ref<CanvasHandle>;
  frameKey: number;
  html: string;
  css: string;
  width: number;
  zoom: number;
  showItems: { root: string; index: number }[];
  children?: ReactNode;
  onPick(id: string, shift: boolean): void;
  onDouble(id: string): void;
  onHover(id: string | null, alt: boolean): void; // alt: Alt held (E3 §3 distances)
  onKey(e: KeyboardEvent): void;
  onPress(id: string, e: PointerEvent): void;
  onFrame(): void;
};
// cross-realm: frame nodes are not instances of this window's Element
const idOf = (t: EventTarget | null): string | null => {
  const node = t as (Node & Partial<Element>) | null;
  const el = node && typeof node.closest === "function" ? (node as Element) : node?.parentElement ?? null;
  return el?.closest("[data-ir-id]")?.getAttribute("data-ir-id") ?? null;
};

export function Canvas({ ref, frameKey, html, css, width, zoom, showItems, children, ...on }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(600);
  const events = useRef(on);
  events.current = on;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const shown = useRef(showItems);
  shown.current = showItems;
  const doc = () => frame.current?.contentDocument ?? null;
  // one token per frame document: until its load handler wired the guards, the frame takes no input (a click would
  // follow a link). ponytail: identity via useMemo, a ref counter if React ever drops the memo
  const docToken = useMemo(() => ({}), [frameKey, html]);
  const [wired, setWired] = useState<object | null>(null);
  const setCss = (text: string) => {
    const style = doc()?.querySelector("style[data-aiwc-css]");
    if (style && style.textContent !== text) style.textContent = text;
  };
  // edit-mode runtime: lay carousels / tabs out at their captured item (R8 of E2)
  const show = () => { for (const s of shown.current) frame.current?.contentWindow?.postMessage({ type: "aiwc:show", root: s.root, index: s.index }, "*"); };
  useImperativeHandle(ref, () => ({
    doc,
    element: (id) => doc()?.querySelector<HTMLElement>(`[data-ir-id="${CSS.escape(id)}"]`) ?? null,
    replace(a, rootOf) {
      const d = doc();
      if (!d) return false;
      for (const s of a.sections) {
        const root = rootOf(s.id);
        const els = root ? d.querySelectorAll(`[data-ir-id="${CSS.escape(root)}"]`) : null;
        if (!els?.length) return false;
        els.forEach((el) => { el.outerHTML = s.html; });
      }
      setCss(a.css);
      show();
      events.current.onFrame();
      return true;
    },
    post: (m) => frame.current?.contentWindow?.postMessage(m, "*"),
    toDoc: (cx, cy) => { const r = frame.current!.getBoundingClientRect(); return { x: (cx - r.left) / zoomRef.current, y: (cy - r.top) / zoomRef.current }; },
    hit: (x, y) => idOf(doc()?.elementFromPoint(x, y) ?? null),
  }));
  useEffect(() => setCss(css), [css]);
  useEffect(() => {
    const el = pane.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(Math.max(200, el.clientHeight - 2)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const onLoad = () => {
    const d = doc(), w = frame.current?.contentWindow;
    if (!d || !w) return;
    setCss(css);
    const stop = (e: Event) => { e.preventDefault(); e.stopPropagation(); };
    // capture on the window: runs before any listener in the document (the runtime's included)
    w.addEventListener("click", (e) => { stop(e); const id = idOf(e.target); if (id) events.current.onPick(id, e.shiftKey); }, true);
    w.addEventListener("dblclick", (e) => { stop(e); const id = idOf(e.target); if (id) events.current.onDouble(id); }, true);
    for (const type of ["auxclick", "submit", "dragover", "drop"]) w.addEventListener(type, stop, true); // drops: a file never opens in the frame
    // §8: pasting into an edited text (contenteditable, Task 12) inserts plain text only, never the clipboard's HTML;
    // on one line: a multi-line insertText splits the host into div blocks the inline edit cannot keep
    w.addEventListener("paste", (e) => {
      if (!(d.activeElement as HTMLElement | null)?.isContentEditable) return;
      stop(e);
      d.execCommand("insertText", false, (e.clipboardData?.getData("text/plain") ?? "").replace(/\s*[\r\n]+\s*/g, " "));
    }, true);
    let last: string | null = null, lastAlt = false;
    d.addEventListener("mousemove", (e) => { const id = idOf(e.target); if (id !== last || e.altKey !== lastAlt) { last = id; lastAlt = e.altKey; events.current.onHover(id, e.altKey); } });
    d.documentElement.addEventListener("mouseleave", () => { last = null; lastAlt = false; events.current.onHover(null, false); });
    d.addEventListener("keydown", (e) => events.current.onKey(e));
    d.addEventListener("pointerdown", (e) => { if (e.button !== 0) return; const id = idOf(e.target); if (id) events.current.onPress(id, e); }, true);
    w.addEventListener("scroll", () => events.current.onFrame(), { passive: true });
    new ResizeObserver(() => events.current.onFrame()).observe(d.documentElement);
    show();
    events.current.onFrame();
    setWired(docToken);
  };
  return (
    <div className="ve-pane" data-ui="ui_editor_canvas_chrome" ref={pane}>
      <div className="ve-stage" style={{ width, height }}>
        <iframe key={frameKey} ref={frame} data-ui="ui_editor_canvas_frame" title="Canvas" sandbox="allow-same-origin allow-scripts" srcDoc={html} onLoad={onLoad}
          inert={wired !== docToken} style={{ width, height, pointerEvents: wired === docToken ? undefined : "none" }} />
        {children}
      </div>
    </div>
  );
}
