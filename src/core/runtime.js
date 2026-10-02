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
  var esc = function (s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&"); };
  var byId = function (id) { return id ? document.querySelector('[data-ir-id="' + esc(id) + '"]') : null; };
  var need = function (id) { var el = byId(id); if (!el) throw new Error("missing node " + id); return el; };
  var on = function (el, type, fn) { if (MODE !== "edit") el.addEventListener(type, fn); };
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
  function hide(el) { el.style.removeProperty("display"); el.style.removeProperty("visibility"); el.style.removeProperty("opacity"); if (shown(el)) el.setAttribute("hidden", ""); }
  var kinds = {};

  kinds.carousel = function (root, c) {
    var vp = need(c.viewport), track = need(c.track), slides = c.slides.map(need), n = slides.length;
    var vertical = c.direction === "vertical", fade = c.transition === "fade", native = vp === track;
    var prev = c.arrows ? byId(c.arrows.prev) : null, next = c.arrows ? byId(c.arrows.next) : null;
    var pag = c.pagination ? byId(c.pagination.container) : null, dots = [], dotOn = "", dotOff = "";
    var i = Math.min(c.active, n - 1), L = { step: 0, last: n - 1 }, hovered = false, timer = 0;
    root.setAttribute("aria-roledescription", "carousel");
    vp.setAttribute("aria-live", c.autoplay && !still ? "off" : "polite");
    slides.forEach(function (s, k) { s.setAttribute("role", "group"); s.setAttribute("aria-roledescription", "slide"); s.setAttribute("aria-label", k + 1 + " / " + n); });
    if (prev && !prev.hasAttribute("aria-label")) prev.setAttribute("aria-label", "Slide trước");
    if (next && !next.hasAttribute("aria-label")) next.setAttribute("aria-label", "Slide sau");
    if (pag && c.pagination.kind === "bullets") {
      // reuse the captured bullets' classes: the active one and an idle one
      var kids = Array.prototype.filter.call(pag.children, function (e) { return e.nodeType === 1; });
      var cur = kids[i] || kids[0], idle = kids.filter(function (e) { return e !== cur; })[0] || cur;
      dotOn = cur ? cur.getAttribute("class") || "" : ""; dotOff = idle ? idle.getAttribute("class") || "" : "";
      // one captured bullet per slide: keep them (DOM and data-ir-id as captured); otherwise rebuild n from the idle one
      var reuse = kids.length === n, proto = idle || document.createElement("button");
      if (!reuse) pag.textContent = "";
      for (var k = 0; k < n; k++) {
        var d = reuse ? kids[k] : proto.cloneNode(true);
        if (!reuse) { d.removeAttribute("data-ir-id"); d.removeAttribute("data-c-role"); Array.prototype.forEach.call(d.querySelectorAll("[data-ir-id]"), function (x) { x.removeAttribute("data-ir-id"); }); }
        if (d.tagName !== "BUTTON") { d.setAttribute("role", "button"); d.tabIndex = 0; }
        d.setAttribute("aria-label", "Tới slide " + (k + 1));
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
      root.setAttribute("data-c-active", String(i));
      if (prev) prev.setAttribute("aria-disabled", String(!c.loop && i === 0)); // aria only: no UA :disabled look (QA pixels)
      if (next) next.setAttribute("aria-disabled", String(!c.loop && i >= L.last));
      dots.forEach(function (d, j) { d.setAttribute("class", j === i ? dotOn : dotOff); d.setAttribute("aria-current", String(j === i)); });
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
    if (MODE !== "edit") vp.style.touchAction = vertical ? "pan-x" : "pan-y"; // the page keeps scrolling the other axis
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
    return { show: function (k) { if (k < n) go(k, true); } };
  };

  function init(root) {
    if (root.__aiwc) return root.__aiwc;
    var id = root.getAttribute("data-ir-id") || "?";
    try {
      var kind = root.getAttribute("data-c"), c = JSON.parse(root.getAttribute("data-c-cfg") || "null");
      if (!c || c.kind !== kind || !Object.prototype.hasOwnProperty.call(kinds, kind)) throw new Error("unknown component " + kind);
      root.__aiwc = kinds[kind](root, c) || {};
    } catch (e) {
      console.warn("aiwc runtime: component skipped", id, e && e.message);
      root.__aiwc = {};
    }
    return root.__aiwc;
  }
  if (MODE === "edit") addEventListener("message", function (e) {
    var d = e.data, ok = d && d.type === "aiwc:show" && e.source === window.parent && Number.isInteger(d.index) && d.index >= 0;
    var root = ok ? byId(d.root) : null, api = root && root.hasAttribute("data-c") ? init(root) : null;
    if (api && api.show) api.show(d.index); // show ignores an index past the last item
  });
  else Array.prototype.forEach.call(document.querySelectorAll("[data-c]"), init);
})();

/* legacy:start */
// legacy [data-behavior] for E1 documents: removed in E2 Task 6 (with its exclusion in tests/unit/runtime-size.test.ts)
(function () {
  var byId = function (id) { return id ? document.getElementById(id) : null; };
  var shown = function (el) { var cs = getComputedStyle(el); return cs.display !== "none" && cs.visibility !== "hidden"; };
  function show(el) {
    el.removeAttribute("hidden");
    if (getComputedStyle(el).display === "none") el.style.setProperty("display", "block");
    if (getComputedStyle(el).visibility === "hidden") el.style.setProperty("visibility", "visible");
  }
  function hide(el) {
    el.style.removeProperty("visibility");
    el.style.removeProperty("display");
    if (shown(el)) el.style.setProperty("display", "none");
  }
  function scroller(from) {
    for (var a = from.parentElement; a; a = a.parentElement) {
      var all = [a].concat(Array.prototype.slice.call(a.querySelectorAll("*")));
      for (var i = 0; i < all.length; i++) if (all[i].scrollWidth > all[i].clientWidth + 1 && getComputedStyle(all[i]).overflowX !== "visible") return all[i];
    }
    return null;
  }
  var openModal = null;
  function closeModal() { if (openModal) hide(openModal); openModal = null; }

  var actions = {
    toggle: function (t) {
      var target = byId(t.getAttribute("aria-controls")) || t.nextElementSibling;
      if (!target) return;
      var open = !shown(target);
      open ? show(target) : hide(target);
      t.setAttribute("aria-expanded", String(open));
    },
    tabs: function (t) {
      var list = t.closest("[role=tablist]");
      if (!list) return;
      list.querySelectorAll("[role=tab]").forEach(function (tab) {
        var on = tab === t, panel = byId(tab.getAttribute("aria-controls"));
        tab.setAttribute("aria-selected", String(on));
        if (panel) on ? show(panel) : hide(panel);
      });
    },
    modal: function (t) {
      var target = byId(t.getAttribute("aria-controls") || t.getAttribute("data-modal"));
      if (!target) return;
      closeModal();
      show(target);
      openModal = target;
    },
    carousel: function (t) {
      var box = scroller(t);
      if (!box) return;
      var back = /prev|back/i.test((t.getAttribute("aria-label") || "") + t.textContent);
      box.scrollBy({ left: back ? -box.clientWidth : box.clientWidth, behavior: "smooth" });
    },
  };

  document.addEventListener("click", function (e) {
    if (openModal && (e.target === openModal || (e.target.closest && e.target.closest("[data-close]")))) return closeModal();
    var t = e.target.closest ? e.target.closest("[data-behavior]") : null;
    var run = t && actions[t.getAttribute("data-behavior")];
    if (!run) return;
    if (t.tagName === "A") e.preventDefault();
    run(t);
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeModal(); });
})();
/* legacy:end */
