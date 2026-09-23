// AI Web Clone runtime: plain browser JS, copied verbatim to out/js/runtime.js (no bundling, works on file://).
// One delegated click handler drives [data-behavior] = toggle | tabs | modal | carousel (sticky is CSS-only).
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
