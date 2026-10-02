// Fixture stand-in for Swiper (E2 R10): the DOM classes, el.swiper.params, loop duplicates per breakpoint (count =
// slidesPerView, like Swiper < 9), autoplay. `expose: false` keeps el.swiper undefined (bundled builds).
window.MiniSwiper = function (el, params, expose) {
  var wrapper = el.querySelector(".swiper-wrapper"), real = Array.prototype.slice.call(wrapper.children), i = 0;
  var pick = function () { var p = { slidesPerView: params.slidesPerView, spaceBetween: params.spaceBetween }; Object.keys(params.breakpoints || {}).map(Number).sort(function (a, b) { return a - b; }).forEach(function (w) { if (innerWidth >= w) Object.assign(p, params.breakpoints[w]); }); return p; };
  function render() {
    var p = pick(), per = p.slidesPerView, gap = p.spaceBetween, w = (el.clientWidth - gap * (per - 1)) / per;
    wrapper.querySelectorAll(".swiper-slide-duplicate").forEach(function (d) { d.remove(); });
    if (params.loop) for (var k = 0; k < per; k++) {
      var head = real[real.length - 1 - k].cloneNode(true), tail = real[k].cloneNode(true);
      head.classList.add("swiper-slide-duplicate"); tail.classList.add("swiper-slide-duplicate");
      wrapper.insertBefore(head, wrapper.firstChild); wrapper.appendChild(tail);
    }
    Array.prototype.forEach.call(wrapper.children, function (s) { s.style.width = w + "px"; s.style.marginRight = gap + "px"; });
    var lead = params.loop ? per : 0;
    wrapper.style.transform = "translate3d(" + -(lead + i) * (w + gap) + "px, 0px, 0px)";
    real.forEach(function (s, k) { s.classList.toggle("swiper-slide-active", k === i); });
    el.querySelectorAll(".swiper-pagination-bullet").forEach(function (b, k) { b.classList.toggle("swiper-pagination-bullet-active", k === i); });
  }
  real.forEach(function (s, k) { s.setAttribute("data-swiper-slide-index", String(k)); });
  var next = el.querySelector(".swiper-button-next"), prev = el.querySelector(".swiper-button-prev");
  if (next) next.addEventListener("click", function () { i = (i + 1) % real.length; render(); });
  if (prev) prev.addEventListener("click", function () { i = (i - 1 + real.length) % real.length; render(); });
  if (params.autoplay) setInterval(function () { i = (i + 1) % real.length; render(); }, params.autoplay.delay);
  addEventListener("resize", render);
  render();
  if (expose !== false) el.swiper = { params: params, get realIndex() { return i; } };
};
