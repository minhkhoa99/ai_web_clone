// AI Web Clone runtime (E2 §4): plain browser JS copied verbatim to out/js/runtime.js — no dependency, no bundling,
// works on file://. Each [data-c] root is one component; data-c-cfg names its parts by data-ir-id. A component whose
// config is broken is skipped with console.warn; the others still run.
// Modes: ?qa=1 on the page (QA: capture state, no autoplay, no motion); runtime.js?edit=1 (editor canvas: only shows
// the item the panel picks through postMessage — no autoplay, no input handlers).
(function () {
  "use strict";
  var me = document.currentScript;
  var MODE = /[?&]edit=1(&|$)/.test(me ? me.src : "") ? "edit" : /[?&]qa=1(&|$)/.test(location.search) ? "qa" : "live";
  var still = MODE !== "live" || !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
  var byId = function (id) { return id ? document.querySelector('[data-ir-id="' + CSS.escape(id) + '"]') : null; };
  var need = function (id) { var el = byId(id); if (!el) throw new Error("missing node " + id); return el; };
  var attr = function (el, k, v) { el.setAttribute(k, v); };
  var on = function (el, type, fn, capture) { if (MODE !== "edit") el.addEventListener(type, fn, capture); };
  var bp = function () { return matchMedia("(max-width: 767.98px)").matches ? "375" : matchMedia("(max-width: 1439.98px)").matches ? "768" : "1440"; };
  // a breakpoint value inherits from the next wider one, like the styles
  function at(map, fallback) {
    var order = { "375": ["375", "768", "1440"], "768": ["768", "1440"], "1440": ["1440"] }[bp()];
    for (var k = 0; k < order.length; k++) if (map && map[order[k]] != null) return map[order[k]];
    return fallback;
  }
  // R13: shown / hidden the way the capture had it ([hidden], display, visibility or opacity)
  function shown(el) { var cs = getComputedStyle(el); return !el.hasAttribute("hidden") && cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0"; }
  function show(el) { el.removeAttribute("hidden"); var cs = getComputedStyle(el); if (cs.display === "none") el.style.display = "block"; if (cs.visibility === "hidden") el.style.visibility = "visible"; if (cs.opacity === "0") el.style.opacity = "1"; }
  function hide(el) { el.style.display = el.style.visibility = el.style.opacity = ""; if (shown(el)) attr(el, "hidden", ""); }
  var kinds = {};

  kinds.carousel = function (root, c) {
    var vp = need(c.viewport), track = need(c.track), slides = c.slides.map(need), n = slides.length;
    var vertical = c.direction === "vertical", fade = c.transition === "fade", native = vp === track;
    var prev = c.arrows ? byId(c.arrows.prev) : null, next = c.arrows ? byId(c.arrows.next) : null;
    var pag = c.pagination ? byId(c.pagination.container) : null, dots = [], dotOn = "", dotOff = "";
    var i = Math.min(c.active, n - 1), L = { step: 0, last: n - 1 }, hovered = false, timer = 0;
    attr(root, "aria-roledescription", "carousel");
    attr(vp, "aria-live", c.autoplay && !still ? "off" : "polite");
    slides.forEach(function (s, k) { attr(s, "role", "group"); attr(s, "aria-roledescription", "slide"); attr(s, "aria-label", k + 1 + " / " + n); });
    if (prev && !prev.hasAttribute("aria-label")) attr(prev, "aria-label", "Slide trước");
    if (next && !next.hasAttribute("aria-label")) attr(next, "aria-label", "Slide sau");
    if (pag && c.pagination.kind === "bullets") {
      // reuse the captured bullets' classes: the active one and an idle one
      var kids = [].filter.call(pag.children, function (e) { return e.nodeType === 1; });
      var cur = kids[i] || kids[0], idle = kids.filter(function (e) { return e !== cur; })[0] || cur;
      dotOn = cur ? cur.getAttribute("class") || "" : ""; dotOff = idle ? idle.getAttribute("class") || "" : "";
      // one captured bullet per slide: keep them (DOM and data-ir-id as captured); otherwise rebuild n from the idle one
      var reuse = kids.length === n, proto = idle || document.createElement("button");
      if (!reuse) pag.textContent = "";
      for (var k = 0; k < n; k++) {
        var d = reuse ? kids[k] : proto.cloneNode(true);
        if (!reuse) { d.removeAttribute("data-ir-id"); d.removeAttribute("data-c-role"); [].forEach.call(d.querySelectorAll("[data-ir-id]"), function (x) { x.removeAttribute("data-ir-id"); }); }
        if (d.tagName !== "BUTTON") { attr(d, "role", "button"); d.tabIndex = 0; }
        attr(d, "aria-label", "Tới slide " + (k + 1));
        if (!reuse) pag.appendChild(d);
        dots.push(d);
      }
    }
    function layout() {
      var per = fade ? 1 : at(c.slidesPerView, 1), gap = fade ? 0 : at(c.gap, 0);
      var box = vertical ? vp.clientHeight : vp.clientWidth, w = (box - gap * (per - 1)) / per;
      if (!fade) {
        track.style.columnGap = track.style.rowGap = "0px";
        slides.forEach(function (s, k) {
          s.style.flex = "0 0 " + w + "px";
          s.style[vertical ? "height" : "width"] = w + "px";
          s.style[vertical ? "marginBottom" : "marginRight"] = (k < n - 1 ? gap : 0) + "px";
        });
      }
      return { step: w + gap, max: Math.max(0, n * (w + gap) - gap - box) };
    }
    // i is always what is visible: past the last position that fits (slidesPerView > 1) there is nowhere to go
    function go(k, instant, auto) {
      var m = layout(), last = m.step > 0 ? Math.min(n - 1, Math.max(0, Math.ceil(m.max / m.step - 0.01))) : n - 1, quick = still || instant;
      i = c.loop ? ((k % (last + 1)) + last + 1) % (last + 1) : Math.max(0, Math.min(k, last));
      var off = Math.min(native ? (vertical ? slides[i].offsetTop - slides[0].offsetTop : slides[i].offsetLeft - slides[0].offsetLeft) : i * m.step, m.max);
      L = { step: m.step, last: last };
      if (fade) slides.forEach(function (s, j) { s.style.transition = quick ? "none" : "opacity " + c.speed + "ms"; s.style.opacity = j === i ? "1" : "0"; s.style.pointerEvents = j === i ? "" : "none"; });
      else if (native) vp.scrollTo(vertical ? { top: off, behavior: quick ? "instant" : "smooth" } : { left: off, behavior: quick ? "instant" : "smooth" });
      else {
        track.style.transition = quick ? "none" : "transform " + c.speed + "ms ease";
        track.style.transform = vertical ? "translate3d(0px, " + -off + "px, 0px)" : "translate3d(" + -off + "px, 0px, 0px)";
      }
      mark();
      if (timer && !auto) { clearInterval(timer); timer = setInterval(tick, c.interval); } // manual move: a full interval again
    }
    function mark() {
      attr(root, "data-c-active", i);
      if (prev) attr(prev, "aria-disabled", !c.loop && i === 0); // aria only: no UA :disabled look (QA pixels)
      if (next) attr(next, "aria-disabled", !c.loop && i >= L.last);
      dots.forEach(function (d, j) { attr(d, "class", j === i ? dotOn : dotOff); attr(d, "aria-current", j === i); });
      if (pag && c.pagination.kind === "fraction") pag.textContent = i + 1 + " / " + n;
    }
    function tick() { if (!hovered && !root.contains(document.activeElement) && !document.hidden) go(c.loop || i < L.last ? i + 1 : 0, false, true); }
    go(i, true);
    // listeners and the autoplay timer only after the first layout worked: a broken component leaves nothing behind
    var step = function (by) { return function (e) { e.preventDefault(); go(i + by); }; };
    dots.forEach(function (d, k) {
      on(d, "click", function (e) { e.preventDefault(); go(k); });
      if (d.tagName !== "BUTTON") on(d, "keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(k); } });
    });
    if (prev) on(prev, "click", step(-1));
    if (next) on(next, "click", step(1));
    // nested components: the innermost one handles a key / swipe and marks it (defaultPrevented); outer ones skip it
    on(root, "keydown", function (e) {
      var back = vertical ? "ArrowUp" : "ArrowLeft", fwd = vertical ? "ArrowDown" : "ArrowRight", t = e.target;
      if (e.defaultPrevented || (e.key !== back && e.key !== fwd) || t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      step(e.key === fwd ? 1 : -1)(e);
    });
    var from = null;
    // transform mode: the page keeps scrolling the other axis; native scroll (viewport === track) keeps the browser's
    // own touch panning, which touch-action would block
    if (MODE !== "edit" && !native) vp.style.touchAction = vertical ? "pan-x" : "pan-y";
    on(vp, "pointerdown", function (e) { from = vertical ? e.clientY : e.clientX; });
    on(vp, "pointercancel", function () { from = null; });
    on(vp, "pointerup", function (e) {
      if (from === null) return;
      var d = (vertical ? e.clientY : e.clientX) - from; from = null;
      if (Math.abs(d) > 40 && !e.defaultPrevented) step(d < 0 ? 1 : -1)(e);
    });
    if (native) { var settle = 0; on(vp, "scroll", function () { clearTimeout(settle); settle = setTimeout(function () { var p = vertical ? vp.scrollTop : vp.scrollLeft; if (L.step) { i = Math.min(L.last, Math.round(p / L.step)); mark(); } }, 120); }); }
    if (c.autoplay && !still) {
      timer = setInterval(tick, c.interval);
      on(root, "mouseenter", function () { hovered = true; }); on(root, "mouseleave", function () { hovered = false; });
    }
    if (MODE !== "edit") addEventListener("resize", function () { go(i, true, true); });
    return { show: function (k) { if (k < n) go(k, true); }, fit: function () { go(i, true, true); } };
  };

  // A part just shown: carousels in it (or the part itself) that were laid out while hidden got zero-size slides; lay
  // them out again now.
  function fit(el) { [el].concat([].slice.call(el.querySelectorAll("[data-c]"))).forEach(function (r) { if (r.__aiwc && r.__aiwc.fit) r.__aiwc.fit(); }); }
  function reveal(el) { show(el); fit(el); }
  // an id for aria-controls / aria-labelledby: the element's own, else one derived from its data-ir-id
  var idOf = function (el) { return el.id || (el.id = "aiwc-" + el.getAttribute("data-ir-id")); };

  kinds.tabs = function (root, c) {
    var list = c.tabs.map(function (x) { return [need(x.trigger), need(x.panel)]; }), n = list.length, i = Math.min(c.active, n - 1);
    // the tabs' common parent is the tablist (only when it holds no panel)
    for (var tl = list[0][0].parentElement; tl && !list.every(function (x) { return tl.contains(x[0]); }); tl = tl.parentElement);
    if (tl && !tl.getAttribute("role") && !list.some(function (x) { return tl.contains(x[1]); })) attr(tl, "role", "tablist");
    list.forEach(function (x) {
      attr(x[0], "role", "tab"); attr(x[0], "aria-controls", idOf(x[1]));
      attr(x[1], "role", "tabpanel"); attr(x[1], "aria-labelledby", idOf(x[0]));
    });
    function go(k, focus) {
      i = (k + n) % n;
      list.forEach(function (x, j) {
        attr(x[0], "aria-selected", j === i); x[0].tabIndex = j === i ? 0 : -1;
        j === i ? reveal(x[1]) : hide(x[1]);
      });
      attr(root, "data-c-active", i);
      if (focus) list[i][0].focus();
    }
    go(i);
    list.forEach(function (x, j) {
      on(x[0], "click", function (e) { e.preventDefault(); go(j); });
      on(x[0], "keydown", function (e) {
        var k = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: n - 1 }[e.key];
        if (k != null) { e.preventDefault(); go(k, true); }
      });
    });
    return { show: function (k) { if (k < n) go(k); } };
  };

  // <details> stays native (the browser opens it; multiple=false closes the others on toggle); other items toggle
  // their panel and aria-expanded. ?qa=1 puts every item back to its captured open state.
  kinds.accordion = function (root, c) {
    var items = c.items.map(function (x) { var t = need(x.trigger), d = t.parentElement; return { t: t, p: need(x.panel), o: x.open, d: t.tagName === "SUMMARY" && d.tagName === "DETAILS" ? d : null }; });
    function set(x, open) { if (x.d) x.d.open = open; else { open ? reveal(x.p) : hide(x.p); attr(x.t, "aria-expanded", open); } }
    function others(j) { if (!c.multiple) items.forEach(function (o, k) { if (k !== j) set(o, false); }); }
    if (MODE === "qa") items.forEach(function (x) { set(x, x.o); });
    items.forEach(function (x, j) {
      if (x.d) on(x.d, "toggle", function () { if (x.d.open) { others(j); fit(x.d); } });
      else {
        attr(x.t, "aria-expanded", shown(x.p));
        on(x.t, "click", function (e) { e.preventDefault(); var open = !shown(x.p); if (open) others(j); set(x, open); });
      }
    });
    return { show: function (j) { if (j < items.length) items.forEach(function (x, k) { set(x, k === j); }); } };
  };

  // Modal: triggers may sit anywhere on the page (Review Focus 5). Focus moves in, stays in (Tab wraps) and returns
  // to the trigger on close. Open dialogs form one stack: only the top one handles Esc / Tab, and the page scroll lock
  // is restored when the stack empties.
  var FOCUSABLE = "a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])";
  var focusables = function (el) { return [].filter.call(el.querySelectorAll(FOCUSABLE), function (x) { return x.getClientRects().length; }); };
  var stack = [], lock = "", de = document.documentElement;
  kinds.modal = function (root, c) {
    var dlg = need(c.dialog), close = byId(c.closeButton), triggers = c.triggers.map(need), from = null;
    var can = function (k) { return c.closeOn.indexOf(k) >= 0; };
    if (!dlg.getAttribute("role")) attr(dlg, "role", "dialog");
    attr(dlg, "aria-modal", "true");
    if (!dlg.hasAttribute("tabindex")) dlg.tabIndex = -1;
    function state(open) { attr(root, "data-c-open", open); triggers.forEach(function (t) { attr(t, "aria-expanded", open); }); }
    triggers.forEach(function (t) { attr(t, "aria-haspopup", "dialog"); });
    state(shown(dlg));
    if (shown(dlg) && MODE !== "edit") stack.push(dlg); // captured open
    function open(t) {
      if (shown(dlg)) return;
      from = t; reveal(dlg); state(true);
      if (MODE === "edit") return; // editor canvas: no scroll lock, no focus move
      if (!stack.length) { lock = de.style.overflow; de.style.overflow = "hidden"; }
      stack.push(dlg);
      (focusables(dlg)[0] || dlg).focus();
    }
    function shut() {
      if (!shown(dlg)) return;
      hide(dlg); state(false);
      var k = stack.indexOf(dlg);
      if (k >= 0) { stack.splice(k, 1); if (!stack.length) de.style.overflow = lock; }
      if (from) from.focus();
      from = null;
    }
    triggers.forEach(function (t) { on(t, "click", function (e) { e.preventDefault(); open(t); }); });
    if (close && can("button")) on(close, "click", function (e) { e.preventDefault(); shut(); });
    if (can("backdrop")) on(dlg, "click", function (e) { if (e.target === dlg) shut(); });
    // a key another component already handled (an open dropdown's Esc, a nested dialog) is skipped
    on(document, "keydown", function (e) {
      if (e.defaultPrevented || stack[stack.length - 1] !== dlg) return;
      if (e.key === "Escape" && can("esc")) { e.preventDefault(); return shut(); }
      if (e.key !== "Tab") return;
      var f = focusables(dlg), a = f[0], z = f[f.length - 1], at = document.activeElement;
      if (!a || !dlg.contains(at) || at === (e.shiftKey ? a : z)) { e.preventDefault(); (a ? (e.shiftKey ? z : a) : dlg).focus(); }
    });
    return { show: function () { open(null); }, hide: shut };
  };

  // Dropdown / menu: openOn click or hover (hover closes 150 ms after the pointer leaves, or when focus leaves trigger
  // and panel); outside click and Esc close it. R2: the panel may sit outside the root (root = trigger), so the panel
  // counts as inside too.
  kinds.dropdown = kinds.menu = function (root, c) {
    var t = need(c.trigger), p = need(c.panel), timer = 0, over = false;
    var inside = function (x) { return !!x && (root.contains(x) || p.contains(x)); };
    function set(open) { clearTimeout(timer); open ? reveal(p) : hide(p); attr(t, "aria-expanded", open); }
    if (c.openOn === "hover") {
      (root.contains(p) ? [root] : [root, p]).forEach(function (el) {
        on(el, "mouseenter", function () { over = true; set(true); });
        on(el, "mouseleave", function () { over = false; clearTimeout(timer); timer = setTimeout(set, 150, false); });
        on(el, "focusout", function (e) { if (!over && !inside(e.relatedTarget)) set(false); });
      });
      on(t, "focus", function () { set(true); });
    } else on(t, "click", function (e) { e.preventDefault(); set(!shown(p)); });
    on(document, "click", function (e) { if (shown(p) && !inside(e.target)) set(false); });
    // capture phase: runs before an enclosing modal's Esc, which then skips the handled key
    on(document, "keydown", function (e) { if (e.key === "Escape" && shown(p)) { e.preventDefault(); t.focus(); set(false); } }, true);
    attr(t, "aria-expanded", shown(p));
    return { show: function () { set(true); }, hide: function () { set(false); } };
  };

  // Video: native <video> gets the spec's flags (autoplay only when live, always muted); embed: the iframe as emitted.
  kinds.video = function (root, c) {
    var v = need(c.node);
    if (c.mode !== "native" || v.tagName !== "VIDEO") return;
    v.muted = c.muted || c.autoplay; v.loop = c.loop; v.controls = c.controls; v.autoplay = c.autoplay && !still;
    v.autoplay ? v.play().catch(function () {}) : v.pause();
  };

  function init(root) {
    if (root.__aiwc) return root.__aiwc;
    var id = root.getAttribute("data-ir-id") || "?";
    try {
      var kind = root.getAttribute("data-c"), c = JSON.parse(root.getAttribute("data-c-cfg") || "null");
      if (!c || c.kind !== kind || !kinds.hasOwnProperty(kind)) throw new Error("unknown component " + kind);
      root.__aiwc = kinds[kind](root, c) || {};
    } catch (e) {
      console.warn("aiwc runtime: component skipped", id, e && e.message);
      root.__aiwc = {};
    }
    return root.__aiwc;
  }
  // aiwc:hide (the panel's selection left the component) closes a shown modal / dropdown; a root never shown is left alone
  if (MODE === "edit") addEventListener("message", function (e) {
    var d = e.data, from = d && e.source === window.parent, root = from && typeof d.root === "string" ? byId(d.root) : null;
    if (d && d.type === "aiwc:hide") return root && root.__aiwc && root.__aiwc.hide && root.__aiwc.hide();
    var ok = root && d.type === "aiwc:show" && Number.isInteger(d.index) && d.index >= 0;
    var api = ok && root.hasAttribute("data-c") ? init(root) : null;
    if (api && api.show) api.show(d.index); // show ignores an index past the last item
  });
  else [].forEach.call(document.querySelectorAll("[data-c]"), init);
})();
