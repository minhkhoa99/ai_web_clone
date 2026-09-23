// Page functions for interactions.ts. Each runs inside the page via
// page.evaluate and must stay self-contained: evaluate serializes only the
// function's own source, so nothing at module scope is visible at runtime.

export type InteractionKind = "hover" | "menu" | "tab" | "accordion" | "modal" | "carousel" | "sticky" | "form";

// `undo` = selector clicked to revert (tab: the default-selected tab),
// `panel` = fallback subtree for an already-selected tab, `next` = carousel control.
export type Candidate = { kind: InteractionKind; trigger: string; undo?: string; panel?: string; next?: string };

// Finds interaction candidates per the spec §6 detection table, grouped in
// scan-priority order (click kinds first, hover last since it is the most
// numerous). Visible elements only; `maxWalk` bounds the full-element walk.
export function findCandidatesInPage(arg: { stateSelectors: string[]; maxWalk: number }): Candidate[] {
  const isUniqueId = (id: string) => document.querySelectorAll(`#${CSS.escape(id)}`).length === 1;
  const selectorFor = (el: Element): string => {
    const parts: string[] = [];
    for (let cur: Element | null = el; cur; cur = cur.parentElement) {
      if (cur.id && isUniqueId(cur.id)) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
        break;
      }
      let n = 1;
      for (let sib = cur.previousElementSibling; sib; sib = sib.previousElementSibling) if (sib.localName === cur.localName) n++;
      parts.unshift(`${cur.localName}:nth-of-type(${n})`);
    }
    return parts.join(" > ");
  };
  const isVisible = (el: Element) => el.checkVisibility() && el.getBoundingClientRect().width > 0;
  const qsa = (selector: string) => Array.from(document.querySelectorAll(selector)).filter(isVisible);

  const found: Record<InteractionKind, Candidate[]> = {
    menu: [], tab: [], accordion: [], modal: [], carousel: [], sticky: [], form: [], hover: [],
  };
  // An element gets at most one click kind (first match in spec order wins).
  const clicked = new Set<Element>();
  const addClick = (kind: InteractionKind, el: Element, extra: Partial<Candidate> = {}) => {
    if (clicked.has(el)) return;
    clicked.add(el);
    found[kind].push({ kind, trigger: selectorFor(el), ...extra });
  };

  for (const list of qsa("[role=tablist]")) {
    const tabs = Array.from(list.querySelectorAll("[role=tab]")).filter(isVisible);
    const selected = tabs.find((t) => t.getAttribute("aria-selected") === "true") ?? tabs[0];
    for (const tab of tabs) {
      const controls = tab.getAttribute("aria-controls");
      addClick("tab", tab, { undo: selectorFor(selected!), panel: controls ? `#${CSS.escape(controls)}` : undefined });
    }
  }
  for (const el of qsa("[aria-haspopup=dialog], [data-modal]")) addClick("modal", el);
  for (const el of qsa("details > summary")) addClick("accordion", el);
  for (const el of qsa("[aria-expanded], [aria-haspopup], [data-toggle]")) addClick("menu", el);
  for (const el of qsa("[aria-controls]")) addClick("accordion", el);

  const carousels = new Set(qsa(".swiper, .slick-slider, .splide"));
  for (const el of Array.from(document.querySelectorAll("body *")).slice(0, arg.maxWalk)) {
    const cs = getComputedStyle(el);
    if (cs.position !== "sticky" && cs.position !== "fixed" && cs.cursor !== "pointer" && cs.scrollSnapType === "none") continue;
    if (!isVisible(el)) continue;
    if (cs.position === "sticky" || cs.position === "fixed") found.sticky.push({ kind: "sticky", trigger: selectorFor(el) });
    if (cs.scrollSnapType !== "none" && /auto|scroll/.test(cs.overflowX)) carousels.add(el);
    // cursor inherits: only the outermost pointer element counts.
    const parent = el.parentElement;
    if (cs.cursor === "pointer" && !(parent && getComputedStyle(parent).cursor === "pointer")) {
      found.hover.push({ kind: "hover", trigger: selectorFor(el) });
    }
  }
  for (const el of carousels) {
    let next: Element | undefined;
    for (let scope: Element | null = el, depth = 0; scope && !next && depth < 3; scope = scope.parentElement, depth++) {
      next = Array.from(scope.querySelectorAll("button, [role=button], a")).find((b) =>
        /next/i.test(`${b.getAttribute("aria-label") ?? ""} ${b.getAttribute("class") ?? ""}`),
      );
    }
    found.carousel.push({ kind: "carousel", trigger: selectorFor(el), next: next ? selectorFor(next) : undefined });
  }

  for (const el of qsa("input, select, textarea")) {
    if ((el as HTMLInputElement).disabled || (el as HTMLInputElement).type === "hidden") continue;
    found.form.push({ kind: "form", trigger: selectorFor(el) });
  }
  for (const selector of arg.stateSelectors) {
    let matches: Element[];
    try {
      matches = qsa(selector);
    } catch {
      continue; // selector valid in CSS but not in querySelectorAll
    }
    for (const el of matches) found.hover.push({ kind: "hover", trigger: selectorFor(el) });
  }

  return Object.values(found).flat();
}

// Own computed style (no custom props) after jumping running transitions to
// their end state, so a :hover/:focus read isn't a mid-transition value.
export function readStyleInPage(selector: string): Record<string, string> {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`element not found: ${selector}`);
  for (const anim of el.getAnimations()) {
    try {
      anim.finish();
    } catch {
      // infinite animations can't finish — leave them running
    }
  }
  const cs = getComputedStyle(el);
  const out: Record<string, string> = {};
  for (let i = 0; i < cs.length; i++) {
    const prop = cs[i]!;
    if (!prop.startsWith("--")) out[prop] = cs.getPropertyValue(prop);
  }
  return out;
}

// State for the reveal pass lives on window between evaluate calls; `any`
// is the window cast for these private slots.
export function markHiddenInPage(maxAdded: number): void {
  const w = window as any;
  w.__ixHidden = Array.from(document.querySelectorAll("body *")).filter((el) => !el.checkVisibility());
  w.__ixAdded = [];
  w.__ixObserver?.disconnect();
  w.__ixObserver = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (node instanceof Element && w.__ixAdded.length < maxAdded) w.__ixAdded.push(node);
      }
    }
  });
  w.__ixObserver.observe(document.body, { childList: true, subtree: true });
}

// Topmost elements that were hidden (or added) since markHiddenInPage and
// are visible now; remembered for the restore check. Returns their
// outerHTML without <script>, or the fallback panel's when nothing was revealed.
export function collectRevealedInPage(panelSelector: string | null): string {
  const w = window as any;
  w.__ixObserver?.disconnect();
  const pool: Element[] = [...(w.__ixHidden ?? []), ...(w.__ixAdded ?? [])];
  const shown = new Set(pool.filter((el) => el.isConnected && el.checkVisibility()));
  const roots = [...shown].filter((el) => !el.parentElement || !shown.has(el.parentElement));
  w.__ixRevealed = roots;
  w.__ixHidden = w.__ixAdded = null;

  const panel = panelSelector ? document.querySelector(panelSelector) : null;
  const subtree = roots.length ? roots : panel?.checkVisibility() ? [panel] : [];
  return subtree
    .map((el) => {
      const copy = el.cloneNode(true) as Element;
      for (const script of Array.from(copy.querySelectorAll("script"))) script.remove();
      return copy.outerHTML;
    })
    .join("\n");
}

export function revealedHiddenInPage(): boolean {
  const roots: Element[] = (window as any).__ixRevealed ?? [];
  return roots.every((el) => !el.checkVisibility());
}
